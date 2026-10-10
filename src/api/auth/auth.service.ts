import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { LoginAuthDto, PasswordResetDto, RegisterAuthDto } from './dto/create-auth.dto';
// import { UpdateAuthDto } from './dto/update-auth.dto';
import { Pool, type PoolClient } from 'pg';
import * as bcrypt from 'bcrypt';
import { OtpGenerateDto } from './dto/generat-otp.dto';
import { Cache } from 'cache-manager';
import { JwtService } from '@nestjs/jwt';
import { Request, Response } from 'express';
import { createHash, randomBytes, randomInt, randomUUID } from 'crypto';
import { UserService } from '../user/user.service';
import { CategoriesService } from '../categories/categories.service';
import { PermissionsService } from '../permissions/permissions.service';
import {
  getCountry,
  isSupportedCurrency,
} from 'src/common/currency/currency.data';
import appConfiguration from 'src/app.configuration';
import {
  REFRESH_COOKIE_NAME,
  readPresentedRefreshToken,
  refreshCookieOptions,
} from './refresh-cookie';
import {
  SESSION_REPLACED_MESSAGE,
  rememberSessionState,
} from './session-state';
import {
  buildRecoveryEmailHtml,
  buildRecoveryEmailText,
  buildVerificationEmailHtml,
  isMailConfigured,
  sendMail,
  shouldOfferInlineRecoveryCode,
} from 'src/utils/mail/mail.util';
import { buildAppPathUrl } from 'src/utils/url/public-app-url';

const EMAIL_VERIFY_TTL_MS = 60 * 60 * 1000; // 1 hour
const EMAIL_VERIFY_TTL_HOURS = 1;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const OTP_TTL_MS = 10 * 60 * 1000;
/** Wrong recovery-code guesses allowed per issued code. */
const OTP_MAX_ATTEMPTS = 5;
const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL = '7d';
/**
 * After a refresh token is rotated, the same (old) token may be presented
 * again for this long — concurrent refreshes from parallel 401s, or a retry
 * after a lost response — and receives the same new token pair instead of
 * tripping reuse detection.
 */
const REFRESH_REUSE_GRACE_MS = 60 * 1000;

/** Refresh tokens are stored as SHA-256 hex (bcrypt only reads 72 bytes). */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
/**
 * Require a verified email before sign-in / API access.
 * On by default; EMAIL_VERIFICATION_REQUIRED=false turns it off (e.g. while
 * outbound mail is not deliverable).
 */
export function isEmailVerificationRequired() {
  const flag = (process.env.EMAIL_VERIFICATION_REQUIRED || '')
    .trim()
    .toLowerCase();
  return !(flag === 'false' || flag === '0' || flag === 'no');
}

export function formatLockRemaining(until: Date): string {
  const totalSeconds = Math.max(
    0,
    Math.ceil((until.getTime() - Date.now()) / 1000),
  );
  if (totalSeconds <= 0) return 'You can try signing in now.';
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (minutes > 0) {
    parts.push(`${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`);
  }
  if (seconds > 0 || minutes === 0) {
    parts.push(`${seconds} ${seconds === 1 ? 'second' : 'seconds'}`);
  }
  return `Try again in ${parts.join(' ')}.`;
}

export class AccountLockedException extends ForbiddenException {
  readonly lockedUntil: string;
  constructor(until: Date) {
    super(
      `Account temporarily locked. ${formatLockRemaining(until)}`,
    );
    this.lockedUntil = until.toISOString();
  }
}

export type OtherLogin = {
  user_agent: string | null;
  created_at: string | null;
  last_used_at: string | null;
};

/** Password was correct, but another device is still signed in. */
export class ActiveSessionException extends ConflictException {
  constructor(sessions: OtherLogin[]) {
    super({
      code: 'ACTIVE_SESSION',
      message:
        'ACTIVE_SESSION: This account is already signed in on another device.',
      sessions,
    });
  }
}

@Injectable()
export class AuthService {
  constructor(
    @Inject('PG_POOL')
    private readonly pgPool: Pool,
    @Inject('CACHE_MANAGER')
    private readonly cacheManager: Cache,
    private readonly jwtService: JwtService,
    private readonly userService: UserService,
    private readonly categoriesService: CategoriesService,
    private readonly permissionsService: PermissionsService,
  ) { }


  async register(registerAuthDto: RegisterAuthDto) {
    const { full_name, password, confirmPassword, country, currency } =
      registerAuthDto;
    const email = registerAuthDto.email.trim().toLowerCase();
    const requireVerification = isEmailVerificationRequired();

    if (password !== confirmPassword) {
      throw new BadRequestException('Password and confirm password do not match');
    }

    if (requireVerification && !isMailConfigured()) {
      throw new ServiceUnavailableException(
        'Email delivery is not configured. Contact the application administrator.',
      );
    }

    const countryCode = country.toUpperCase();
    const countryMeta = getCountry(countryCode);
    if (!countryMeta) {
      throw new BadRequestException('Unsupported country');
    }
    const baseCurrency = (currency || countryMeta.currency).toUpperCase();
    if (!isSupportedCurrency(baseCurrency)) {
      throw new BadRequestException('Unsupported currency');
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const client = await this.pgPool.connect();
    let user: any;
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO users (full_name, email, password_hash, country, currency, email_verified)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, full_name, email, country, currency, timezone, locale, email_verified`,
        [
          full_name,
          email,
          passwordHash,
          countryCode,
          baseCurrency,
          !requireVerification,
        ],
      );
      user = result.rows[0];
      await this.categoriesService.seedDefaultsForUser(user.id, client);
      await client.query('COMMIT');
    } catch (error: any) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore rollback errors */
      }
      if (error?.code === '23505') {
        throw new ConflictException('Email already exists');
      }
      if (
        error instanceof ServiceUnavailableException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      throw new InternalServerErrorException('Failed to register user');
    } finally {
      client.release();
    }

    // The account exists from here on. Follow-up steps are best-effort: a
    // failure must not turn a successful sign-up into an error response.
    try {
      await this.permissionsService.markAdminIfBootstrapEmail(user.id, user.email);
      await this.permissionsService.ensureFirstUserIsAdmin();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(
        '[Opal] Admin bootstrap after register failed:',
        error instanceof Error ? error.message : error,
      );
    }

    let access: { is_admin: boolean; permissions: string[] } = {
      is_admin: false,
      permissions: [],
    };
    try {
      access = await this.permissionsService.mePayload(user.id);
    } catch {
      /* permissions are re-read on sign-in */
    }

    let verificationEmailSent = false;
    if (requireVerification) {
      try {
        await this.sendVerificationEmail(user.id, user.email, user.full_name);
        verificationEmailSent = true;
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(
          '[Opal] Verification email after register failed:',
          error instanceof Error ? error.message : error,
        );
      }
    }

    try {
      await this.userService.syncUsersToCache();
    } catch {
      /* cache refresh is best-effort */
    }

    return {
      ...user,
      is_admin: access.is_admin,
      permissions: access.permissions,
      requires_email_verification: requireVerification,
      verification_email_sent: verificationEmailSent,
      message: !requireVerification
        ? 'Account created. You can sign in now.'
        : verificationEmailSent
          ? 'Account created. Please verify your email before signing in.'
          : 'Account created, but we could not send the verification email. Use "Resend verification" to get a new link.',
    };
  }

  async verifyEmail(token: string) {
    const raw = (token || '').trim();
    if (!raw) throw new BadRequestException('Verification token is required');
    const payload = await this.cacheManager.get<{
      userId: string;
      email: string;
    }>(`email-verify:${raw}`);
    if (!payload?.userId) {
      throw new BadRequestException(
        'Verification link is invalid or has expired. Request a new one from the sign-in page.',
      );
    }
    // Idempotent: safe to call twice (React Strict Mode / double-click).
    // Keep the token until TTL so a second request still succeeds.
    await this.pgPool.query(
      `UPDATE users SET email_verified = TRUE, updated_at = NOW() WHERE id = $1`,
      [payload.userId],
    );
    await this.userService.syncUsersToCache();
    return {
      message: 'Email verified successfully. You can sign in now.',
      email: payload.email,
    };
  }

  async resendVerification(emailInput: string) {
    const email = emailInput.trim().toLowerCase();
    const userResult = await this.pgPool.query(
      `SELECT id, email, full_name, email_verified FROM users WHERE email = $1 AND deleted_at IS NULL`,
      [email],
    );
    if (userResult.rowCount === 0) {
      return {
        message:
          'If an unverified account exists for this email, a verification link has been sent.',
      };
    }
    const user = userResult.rows[0];
    if (user.email_verified) {
      return { message: 'This email is already verified. You can sign in.' };
    }
    await this.sendVerificationEmail(user.id, user.email, user.full_name);
    return {
      message:
        'If an unverified account exists for this email, a verification link has been sent.',
    };
  }

  private async sendVerificationEmail(
    userId: string,
    email: string,
    fullName?: string | null,
  ) {
    if (!isMailConfigured()) {
      throw new ServiceUnavailableException(
        'Email delivery is not configured. Contact the application administrator.',
      );
    }
    const previous = await this.cacheManager.get<string>(
      `email-verify-user:${userId}`,
    );
    if (previous) {
      await this.cacheManager.del(`email-verify:${previous}`);
    }
    const token = randomBytes(32).toString('hex');
    await this.cacheManager.set(
      `email-verify:${token}`,
      { userId, email },
      EMAIL_VERIFY_TTL_MS,
    );
    await this.cacheManager.set(
      `email-verify-user:${userId}`,
      token,
      EMAIL_VERIFY_TTL_MS,
    );

    const verifyUrl = buildAppPathUrl('/verify-email', { token });
    // eslint-disable-next-line no-console
    console.info(`[Opal] Verification link host: ${new URL(verifyUrl).origin}`);
    const greeting = fullName?.trim() ? `Hello ${fullName.trim()},` : 'Hello,';
    const text = [
      greeting,
      '',
      `Confirm this email address to continue. This link expires in ${EMAIL_VERIFY_TTL_HOURS} hour.`,
      '',
      verifyUrl,
      '',
      'If you did not create this account, you can ignore this email.',
    ].join('\n');

    try {
      await sendMail({
        to: email,
        subject: 'Verify your email',
        text,
        html: buildVerificationEmailHtml({
          fullName,
          verifyUrl,
          expiresHours: EMAIL_VERIFY_TTL_HOURS,
        }),
      });
    } catch {
      await this.cacheManager.del(`email-verify:${token}`);
      await this.cacheManager.del(`email-verify-user:${userId}`);
      throw new ServiceUnavailableException(
        'Verification email could not be sent. Please try again later.',
      );
    }

    if (process.env.NODE_ENV !== 'production') {
      // Helpful for local testing when the mailbox is hard to reach.
      // eslint-disable-next-line no-console
      console.info(`[Opal] Email verification link for ${email}: ${verifyUrl}`);
    }
  }

  async generateOtp(dto: OtpGenerateDto) {
    const email = dto.email.trim().toLowerCase();
    const allowInline = shouldOfferInlineRecoveryCode();
    const canEmail = isMailConfigured();

    if (!canEmail && !allowInline) {
      throw new ServiceUnavailableException(
        'Password recovery email is not configured. Contact the application administrator.',
      );
    }

    const user = await this.pgPool.query(
      'SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL',
      [email],
    );
    const genericResponse = {
      message:
        'If an account exists for this email, a recovery code has been sent.',
      delivery: 'email' as const,
    };
    // Same generic message when the account is missing (avoid email enumeration).
    if (user.rowCount === 0) {
      return genericResponse;
    }

    const otp = randomInt(100000, 1_000_000).toString();
    const key = `${email}-otp`;
    await this.cacheManager.set(key, otp, OTP_TTL_MS);
    await this.cacheManager.del(`${email}-otp-attempts`);

    if (canEmail && !allowInline) {
      // Send in the background and answer exactly as for an unknown email, so
      // neither the response nor its timing reveals whether the account exists.
      void this.sendRecoveryCode(email, otp).catch(async (err) => {
        // eslint-disable-next-line no-console
        console.error(
          '[Opal] Recovery email failed:',
          err instanceof Error ? err.message : err,
        );
        try {
          if ((await this.cacheManager.get<string>(key)) === otp) {
            await this.cacheManager.del(key);
          }
        } catch {
          /* ignore cache errors */
        }
      });
      return genericResponse;
    }

    // Inline OTP (opt-in via PASSWORD_RESET_INLINE_CODE). Email is skipped
    // entirely: the mail API can accept a message that later bounces, which
    // would leave the user with no code at all.
    // eslint-disable-next-line no-console
    console.warn(`[Opal] Inline recovery code issued for ${email}.`);
    return {
      message:
        'Email delivery is unavailable on this server. Use the on-screen recovery code to reset your password.',
      delivery: 'inline' as const,
      recovery_code: otp,
    };
  }

  async verifyRecoveryOtp(dto: {
    email: string;
    otp: string;
  }) {
    const email = dto.email.trim().toLowerCase();
    const otp = String(dto.otp || '').trim();
    const key = `${email}-otp`;
    const attemptsKey = `${email}-otp-attempts`;
    const cachedOtp = await this.cacheManager.get<string>(key);

    if (!cachedOtp || cachedOtp !== otp) {
      if (cachedOtp) {
        // Limit guesses per issued code; burn it after too many misses.
        const attempts =
          (Number(await this.cacheManager.get<number>(attemptsKey)) || 0) + 1;
        if (attempts >= OTP_MAX_ATTEMPTS) {
          await this.cacheManager.del(key);
          await this.cacheManager.del(attemptsKey);
          throw new BadRequestException(
            'Too many incorrect codes. Request a new recovery code.',
          );
        }
        await this.cacheManager.set(attemptsKey, attempts, OTP_TTL_MS);
      }
      throw new BadRequestException('Invalid OTP');
    }

    const resetToken = randomUUID();
    await this.cacheManager.set(
      `${email}-reset-token`,
      resetToken,
      10 * 60 * 1000,
    );
    // OTP is single-use once verified.
    await this.cacheManager.del(key);
    await this.cacheManager.del(attemptsKey);

    return {
      message: 'Code verified. You can set a new password.',
      reset_token: resetToken,
    };
  }

  async resetPassword(dto: PasswordResetDto) {
    const { newPassword, confirmNewPassword, resetToken } = dto;
    const email = dto.email.trim().toLowerCase();

    if (newPassword !== confirmNewPassword) {
      throw new BadRequestException(
        'New password and confirm new password do not match',
      );
    }

    const tokenKey = `${email}-reset-token`;
    const cachedToken = await this.cacheManager.get<string>(tokenKey);
    if (!cachedToken || cachedToken !== String(resetToken || '').trim()) {
      throw new BadRequestException(
        'Reset session expired or invalid. Request a new recovery code.',
      );
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    const client = await this.pgPool.connect();
    let updated = false;
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE users
         SET password_hash = $1,
             failed_login_attempts = 0,
             locked_until = NULL,
             updated_at = NOW()
         WHERE email = $2 AND deleted_at IS NULL
         RETURNING id`,
        [passwordHash, email],
      );
      if (result.rowCount) {
        // A password reset signs out every existing session.
        await this.revokeAllSessions(result.rows[0].id, client);
        updated = true;
      }
      await client.query('COMMIT');
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore rollback errors */
      }
      throw new InternalServerErrorException('Failed to reset password');
    } finally {
      client.release();
    }

    await this.cacheManager.del(tokenKey);
    await this.cacheManager.del(`${email}-otp`);
    if (!updated) {
      throw new BadRequestException(
        'Reset session expired or invalid. Request a new recovery code.',
      );
    }
    return { message: 'Password reset successfully' };
  }

  private async sendRecoveryCode(email: string, otp: string) {
    if (!isMailConfigured()) {
      throw new ServiceUnavailableException(
        'Password recovery email is not configured. Contact the application administrator.',
      );
    }
    await sendMail({
      to: email,
      subject: 'Password recovery code',
      text: buildRecoveryEmailText(otp),
      html: buildRecoveryEmailHtml({ otp }),
    });
  }

  async login(dto: LoginAuthDto, req: Request) {
    const email = dto.email.trim().toLowerCase();
    const { password } = dto;

    const client = await this.pgPool.connect();

    try {
      await client.query('BEGIN');

      const userResult = await client.query(
        `
      SELECT id, email, password_hash, full_name, country, currency, timezone, locale,
             avatar_url, email_verified, failed_login_attempts, 
             locked_until, deleted_at, is_admin
      FROM users
      WHERE email = $1
      `,
        [email]
      );

      if (userResult.rowCount === 0) {
        throw new UnauthorizedException('Invalid credentials');
      }

      const user = userResult.rows[0];

      // Soft delete check
      if (user.deleted_at) {
        throw new UnauthorizedException('Invalid credentials');
      }

      // Account lock check
      if (user.locked_until && new Date(user.locked_until) > new Date()) {
        throw new AccountLockedException(new Date(user.locked_until));
      }

      const isPasswordValid = await bcrypt.compare(
        password,
        user.password_hash
      );

      if (!isPasswordValid) {
        // Atomic increment; an expired lock starts a fresh count so the next
        // wrong password after a lockout does not immediately re-lock.
        const counted = await client.query(
          `
        UPDATE users
        SET failed_login_attempts = CASE
              WHEN locked_until IS NOT NULL AND locked_until < NOW() THEN 1
              ELSE COALESCE(failed_login_attempts, 0) + 1
            END,
            locked_until = CASE
              WHEN locked_until IS NOT NULL AND locked_until < NOW() THEN NULL
              ELSE locked_until
            END
        WHERE id = $1
        RETURNING failed_login_attempts
        `,
          [user.id]
        );
        const attempts = Number(counted.rows[0]?.failed_login_attempts) || 0;

        let lockedUntil: Date | null = null;

        if (attempts >= LOGIN_MAX_ATTEMPTS) {
          lockedUntil = new Date(Date.now() + LOGIN_LOCK_MS);
          await client.query(
            `UPDATE users SET locked_until = $1 WHERE id = $2`,
            [lockedUntil, user.id],
          );
        }

        await client.query('COMMIT');

        if (lockedUntil) {
          throw new AccountLockedException(lockedUntil);
        }

        throw new UnauthorizedException('Invalid credentials');
      }

      // Only after a valid password: block unverified accounts and resend link.
      if (isEmailVerificationRequired() && !user.email_verified) {
        await client.query('ROLLBACK');
        try {
          await this.sendVerificationEmail(user.id, user.email, user.full_name);
        } catch {
          // Still block login even if resend fails.
        }
        throw new ForbiddenException(
          'EMAIL_NOT_VERIFIED: Please verify your email. We sent a fresh verification link.',
        );
      }

      if (!dto.replace_other_sessions) {
        const presented = readPresentedRefreshToken(req);
        const currentHash = presented ? hashRefreshToken(presented) : null;
        const active = await client.query(
          `SELECT user_agent, created_at, updated_at AS last_used_at
           FROM user_sessions
           WHERE user_id = $1
             AND revoked_at IS NULL
             AND expires_at > NOW()
             AND COALESCE(is_delete, false) = false
             AND ($2::text IS NULL OR refresh_token IS DISTINCT FROM $2::text)
           ORDER BY updated_at DESC NULLS LAST, created_at DESC
           LIMIT 20`,
          [user.id, currentHash],
        );
        if (active.rowCount) {
          await client.query(
            `UPDATE users
             SET failed_login_attempts = 0, locked_until = NULL
             WHERE id = $1`,
            [user.id],
          );
          await client.query('COMMIT');
          throw new ActiveSessionException(
            active.rows.map((row) => ({
              user_agent: (row.user_agent as string | null) ?? null,
              created_at: row.created_at
                ? new Date(row.created_at).toISOString()
                : null,
              last_used_at: row.last_used_at
                ? new Date(row.last_used_at).toISOString()
                : null,
            })),
          );
        }
      }

      return await this.issueSession(client, user, req);
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* The active-session check already committed. */
      }
      throw error;
    } finally {
      client.release();
      await this.userService.syncUsersToCache()
    }
  }

  private async issueSession(client: PoolClient, user: any, req: Request) {
    await client.query(
      `UPDATE users
       SET failed_login_attempts = 0,
           locked_until = NULL,
           last_login_at = NOW()
       WHERE id = $1`,
      [user.id],
    );

    const refreshToken = await this.signRefreshToken(user.id);
    const refreshTokenHash = hashRefreshToken(refreshToken);
    const clientHeader =
      req.headers['x-opal-client'] ?? req.headers['x-finos-client'];
    const clientPlatform =
      (typeof clientHeader === 'string'
        ? clientHeader
        : Array.isArray(clientHeader)
          ? clientHeader[0]
          : '') || '';
    const rawUa = req.headers['user-agent'] || null;
    const userAgent = clientPlatform
      ? `[opal:${clientPlatform}] ${rawUa || ''}`.trim()
      : rawUa;

    // Reached only when no other device is signed in, or the person
    // confirmed on the sign-in screen that those sessions should end.
    const replaced = await client.query(
      `UPDATE user_sessions
       SET revoked_at = NOW(), revoked_reason = 'replaced', updated_at = NOW()
       WHERE user_id = $1 AND revoked_at IS NULL
       RETURNING id`,
      [user.id],
    );
    const inserted = await client.query(
      `INSERT INTO user_sessions
        (user_id, session_token, refresh_token, user_agent, ip_address, expires_at)
       VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '7 days')
       RETURNING id`,
      [user.id, randomUUID(), refreshTokenHash, userAgent, req.ip],
    );
    await client.query('COMMIT');
    const sessionId = String(inserted.rows[0].id);
    await Promise.all([
      ...replaced.rows.map((row) =>
        rememberSessionState(this.cacheManager, String(row.id), 'replaced'),
      ),
      rememberSessionState(this.cacheManager, sessionId, 'active'),
    ]);
    const accessToken = await this.signAccessToken(
      user.id,
      user.email,
      sessionId,
    );

    const access = await this.permissionsService.mePayload(user.id);
    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        country: user.country,
        currency: user.currency || 'USD',
        timezone: user.timezone,
        locale: user.locale,
        avatar_url: user.avatar_url || null,
        is_admin: access.is_admin,
        permissions: access.permissions,
      },
    };
  }

  /** `sid` ties the token to its session so a replaced device is cut off. */
  private signAccessToken(
    userId: string,
    email?: string | null,
    sessionId?: string | null,
  ) {
    return this.jwtService.signAsync(
      {
        sub: userId,
        ...(email ? { email } : {}),
        ...(sessionId ? { sid: sessionId } : {}),
        typ: 'access',
      },
      {
        expiresIn: ACCESS_TOKEN_TTL,
        secret: appConfiguration().JWT.SECRET,
      },
    );
  }

  /** Unique per issue (jti) so every session row gets a distinct hash. */
  private signRefreshToken(userId: string) {
    return this.jwtService.signAsync(
      { sub: userId, typ: 'refresh', jti: randomUUID() },
      {
        expiresIn: REFRESH_TOKEN_TTL,
        secret: appConfiguration().JWT.REFRESH_SECRET,
      },
    );
  }

  private async revokeAllSessions(
    userId: string,
    client: Pick<Pool, 'query'> | PoolClient = this.pgPool,
  ) {
    const revoked = await client.query(
      `UPDATE user_sessions
       SET revoked_at = NOW(), updated_at = NOW()
       WHERE user_id = $1 AND revoked_at IS NULL
       RETURNING id`,
      [userId],
    );
    await Promise.all(
      revoked.rows.map((row) =>
        rememberSessionState(this.cacheManager, String(row.id), 'ended'),
      ),
    );
  }

  /**
   * Sessions created before the SHA-256 switch store bcrypt hashes. Kept for
   * one release so already signed-in users are not logged out; a match is
   * rotated onto the new scheme by the caller.
   */
  private async findLegacyBcryptSession(
    userId: string,
    refreshToken: string,
  ): Promise<{ id: string; refresh_token: string } | null> {
    const result = await this.pgPool.query(
      `SELECT id, refresh_token FROM user_sessions
       WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()
         AND refresh_token LIKE $2
       ORDER BY created_at DESC`,
      [userId, '$2%'],
    );
    for (const candidate of result.rows) {
      if (await bcrypt.compare(refreshToken, candidate.refresh_token)) {
        return candidate;
      }
    }
    return null;
  }

  private async readRefreshGrace(
    tokenHash: string,
  ): Promise<{ accessToken: string; refreshToken: string } | null> {
    try {
      const cached = await this.cacheManager.get<{
        accessToken: string;
        refreshToken: string;
      }>(`refresh-grace:${tokenHash}`);
      return cached?.accessToken && cached?.refreshToken ? cached : null;
    } catch {
      return null;
    }
  }

  async refreshToken(presentedToken: string, res: Response) {
    const refreshToken = String(presentedToken || '').trim();
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token missing');
    }
    let payload: any;
    try {
      payload = await this.jwtService.verifyAsync(refreshToken, {
        secret: appConfiguration().JWT.REFRESH_SECRET,
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
    // Only refresh tokens may be exchanged. Tokens without `typ` predate this
    // release and are accepted only via a legacy bcrypt session row below.
    if (!payload?.sub || (payload.typ !== undefined && payload.typ !== 'refresh')) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    const userId = String(payload.sub);
    const presentedHash = hashRefreshToken(refreshToken);

    const graced = await this.readRefreshGrace(presentedHash);
    if (graced) {
      res.cookie(REFRESH_COOKIE_NAME, graced.refreshToken, refreshCookieOptions());
      return graced;
    }

    const userResult = await this.pgPool.query(
      `SELECT id, email FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    if (!userResult.rowCount) {
      await this.revokeAllSessions(userId);
      throw new UnauthorizedException('Session not found');
    }

    const newRefreshToken = await this.signRefreshToken(userId);
    const newRefreshTokenHash = hashRefreshToken(newRefreshToken);

    // Rotate atomically: only the request whose token still matches the
    // stored hash wins, so a token can be exchanged once.
    let rotated = false;
    let sessionId: string | null = null;
    if (payload.typ === 'refresh') {
      const result = await this.pgPool.query(
        `UPDATE user_sessions
         SET refresh_token = $3,
             session_token = $4,
             expires_at = NOW() + INTERVAL '7 days',
             updated_at = NOW()
         WHERE user_id = $1 AND refresh_token = $2
           AND revoked_at IS NULL AND expires_at > NOW()
         RETURNING id`,
        [userId, presentedHash, newRefreshTokenHash, randomUUID()],
      );
      rotated = Boolean(result.rowCount);
      sessionId = result.rows[0]?.id ? String(result.rows[0].id) : null;
    } else {
      const legacy = await this.findLegacyBcryptSession(userId, refreshToken);
      if (legacy) {
        const result = await this.pgPool.query(
          `UPDATE user_sessions
           SET refresh_token = $3,
               session_token = $4,
               expires_at = NOW() + INTERVAL '7 days',
               updated_at = NOW()
           WHERE id = $1 AND refresh_token = $2 AND revoked_at IS NULL
           RETURNING id`,
          [legacy.id, legacy.refresh_token, newRefreshTokenHash, randomUUID()],
        );
        rotated = Boolean(result.rowCount);
        sessionId = result.rows[0]?.id ? String(result.rows[0].id) : null;
      }
    }

    if (!rotated) {
      // Possibly a concurrent refresh that rotated this token a moment ago.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const racedGrace = await this.readRefreshGrace(presentedHash);
      if (racedGrace) {
        res.cookie(
          REFRESH_COOKIE_NAME,
          racedGrace.refreshToken,
          refreshCookieOptions(),
        );
        return racedGrace;
      }
      // The token is still the latest one of a session that was deliberately
      // ended (logout, "sign out other devices", per-session revoke) or that
      // expired: reject it without touching the user's other sessions.
      const ended = await this.pgPool.query(
        `SELECT revoked_reason FROM user_sessions
         WHERE user_id = $1 AND refresh_token = $2
           AND (revoked_at IS NOT NULL OR expires_at <= NOW())
         LIMIT 1`,
        [userId, presentedHash],
      );
      if (ended.rowCount) {
        throw new UnauthorizedException(
          ended.rows[0].revoked_reason === 'replaced'
            ? SESSION_REPLACED_MESSAGE
            : 'Session expired or was signed out. Please sign in again.',
        );
      }
      // A validly signed refresh token that matches no session row was
      // already rotated away: treat it as stolen and end every session.
      await this.revokeAllSessions(userId);
      throw new UnauthorizedException(
        'Session expired or was signed out. Please sign in again.',
      );
    }

    const newAccessToken = await this.signAccessToken(
      userId,
      userResult.rows[0].email,
      sessionId,
    );
    const tokens = {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    };
    try {
      await this.cacheManager.set(
        `refresh-grace:${presentedHash}`,
        tokens,
        REFRESH_REUSE_GRACE_MS,
      );
    } catch {
      /* grace window is best-effort */
    }

    res.cookie(REFRESH_COOKIE_NAME, newRefreshToken, refreshCookieOptions());
    return tokens;
  }

  /** Revoke the session behind a refresh token (logout). Always succeeds. */
  async logout(presentedToken: string) {
    const refreshToken = String(presentedToken || '').trim();
    if (!refreshToken) return { message: 'Signed out' };

    const tokenHash = hashRefreshToken(refreshToken);
    try {
      await this.cacheManager.del(`refresh-grace:${tokenHash}`);
    } catch {
      /* ignore cache errors */
    }

    const revoked = await this.pgPool.query(
      `UPDATE user_sessions
       SET revoked_at = NOW(), updated_at = NOW()
       WHERE refresh_token = $1 AND revoked_at IS NULL
       RETURNING id`,
      [tokenHash],
    );
    for (const row of revoked.rows) {
      await rememberSessionState(this.cacheManager, String(row.id), 'ended');
    }
    if (!revoked.rowCount) {
      // Legacy (pre-SHA-256) session: needs the user id to find the row.
      try {
        const payload: any = await this.jwtService.verifyAsync(refreshToken, {
          secret: appConfiguration().JWT.REFRESH_SECRET,
        });
        if (payload?.sub && payload.typ === undefined) {
          const legacy = await this.findLegacyBcryptSession(
            String(payload.sub),
            refreshToken,
          );
          if (legacy) {
            await this.pgPool.query(
              `UPDATE user_sessions
               SET revoked_at = NOW(), updated_at = NOW()
               WHERE id = $1`,
              [legacy.id],
            );
          }
        }
      } catch {
        /* invalid or expired token: nothing to revoke */
      }
    }
    return { message: 'Signed out' };
  }



}
