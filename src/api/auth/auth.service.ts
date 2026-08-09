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
import { Pool } from 'pg';
import * as bcrypt from 'bcrypt';
import { OtpGenerateDto } from './dto/generat-otp.dto';
import { Cache } from 'cache-manager';
import { JwtService } from '@nestjs/jwt';
import { Request, Response } from 'express';
import { randomBytes, randomInt, randomUUID } from 'crypto';
import { UserService } from '../user/user.service';
import { CategoriesService } from '../categories/categories.service';
import { PermissionsService } from '../permissions/permissions.service';
import {
  getCountry,
  isSupportedCurrency,
} from 'src/common/currency/currency.data';
import appConfiguration from 'src/app.configuration';
import { REFRESH_COOKIE_NAME, refreshCookieOptions } from './refresh-cookie';
import {
  buildVerificationEmailHtml,
  isMailConfigured,
  sendMail,
} from 'src/utils/mail/mail.util';

const EMAIL_VERIFY_TTL_MS = 60 * 60 * 1000; // 1 hour
const EMAIL_VERIFY_TTL_HOURS = 1;
/** Temporarily off: Resend free tier can only send to the account owner. */
const REQUIRE_EMAIL_VERIFICATION = false;

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
    const { full_name, email, password, confirmPassword, country, currency } =
      registerAuthDto;

    if (password !== confirmPassword) {
      throw new BadRequestException('Password and confirm password do not match');
    }

    // if (REQUIRE_EMAIL_VERIFICATION && !isMailConfigured()) {
    //   throw new ServiceUnavailableException(
    //     'Email delivery is not configured. Contact the application administrator.',
    //   );
    // }

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
          !REQUIRE_EMAIL_VERIFICATION,
        ],
      );
      const user = result.rows[0];
      await this.categoriesService.seedDefaultsForUser(user.id, client);
      await client.query('COMMIT');
      await this.permissionsService.markAdminIfBootstrapEmail(user.id, user.email);
      const access = await this.permissionsService.mePayload(user.id);
      // if (REQUIRE_EMAIL_VERIFICATION) {
      //   await this.sendVerificationEmail(user.id, user.email, user.full_name);
      // }
      return {
        ...user,
        is_admin: access.is_admin,
        permissions: access.permissions,
        message: REQUIRE_EMAIL_VERIFICATION
          ? 'Account created. Please verify your email before signing in.'
          : 'Account created. You can sign in now.',
      };
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
      await this.userService.syncUsersToCache()
    }
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

    const clientHost = (
      process.env.CLIENT_HOST ||
      process.env.FRONTEND_URL ||
      'http://localhost:3000'
    ).replace(/\/$/, '');
    const verifyUrl = `${clientHost}/verify-email?token=${token}`;
    const text = `Hi ${fullName || 'there'},\n\nVerify your FinOS email by opening this link (expires in ${EMAIL_VERIFY_TTL_HOURS} hour):\n${verifyUrl}\n\nIf you did not create this account, ignore this email.`;

    try {
      await sendMail({
        to: email,
        subject: 'Verify your FinOS email',
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
      console.info(`[FinOS] Email verification link for ${email}: ${verifyUrl}`);
    }
  }

  async generateOtp(dto: OtpGenerateDto) {
    const email = dto.email.trim().toLowerCase();
    if (
      !isMailConfigured()
    ) {
      throw new ServiceUnavailableException(
        'Password recovery email is not configured. Contact the application administrator.',
      );
    }
    const user = await this.pgPool.query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    )
    if (user.rowCount === 0) {
      return {
        message:
          'If an account exists for this email, a recovery code has been sent.',
      };
    }
    const otp = randomInt(100000, 1_000_000).toString();
    const key = `${email}-otp`;
    await this.cacheManager.set(key, otp, 10 * 60 * 1000);
    try {
      await this.sendRecoveryCode(email, otp);
    } catch {
      await this.cacheManager.del(key);
      throw new ServiceUnavailableException(
        'Recovery email could not be sent. Please try again later.',
      );
    }
    return {
      message:
        'If an account exists for this email, a recovery code has been sent.',
    };
  }

  async resetPassword(dto: PasswordResetDto) {
    const { newPassword, confirmNewPassword, otp } = dto;
    const email = dto.email.trim().toLowerCase();

    if (newPassword !== confirmNewPassword) {
      throw new BadRequestException('New password and confirm new password do not match');
    }

    const key = `${email}-otp`;
    const cachedOtp = await this.cacheManager.get<string>(key);
    if (cachedOtp !== otp) {
      throw new BadRequestException('Invalid OTP');
    }
    const passwordHash = await bcrypt.hash(newPassword, 10);
    const client = await this.pgPool.connect();
    try {
      await client.query(
        'UPDATE users SET password_hash = $1 WHERE email = $2',
        [passwordHash, email]
      );
      await this.cacheManager.del(key);
      return { message: 'Password reset successfully' };
    } catch (error) {
      throw new InternalServerErrorException('Failed to reset password');
    } finally {
      client.release();
    }
  }

  private async sendRecoveryCode(email: string, otp: string) {
    if (!isMailConfigured()) {
      throw new ServiceUnavailableException(
        'Password recovery email is not configured. Contact the application administrator.',
      );
    }
    await sendMail({
      to: email,
      subject: 'Your FinOS password recovery code',
      text: `Your FinOS recovery code is ${otp}. It expires in 10 minutes. If you did not request this, ignore this email.`,
      html: `<p>Your FinOS recovery code is:</p><p style="font-size:24px;font-weight:700;letter-spacing:4px">${otp}</p><p>It expires in 10 minutes. If you did not request this, ignore this email.</p>`,
    });
  }

  async login(dto: LoginAuthDto, req: Request) {
    const { email, password } = dto;

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
        throw new ForbiddenException('Account temporarily locked. Try later.');
      }

      const isPasswordValid = await bcrypt.compare(
        password,
        user.password_hash
      );

      if (!isPasswordValid) {
        const attempts = user.failed_login_attempts + 1;

        let lockedUntil: Date | null = null;

        if (attempts >= 5) {
          lockedUntil = new Date(Date.now() + 15 * 60 * 1000); // 15 min
        }

        await client.query(
          `
        UPDATE users
        SET failed_login_attempts = $1,
            locked_until = $2
        WHERE id = $3
        `,
          [attempts, lockedUntil, user.id]
        );

        await client.query('COMMIT');

        throw new UnauthorizedException('Invalid credentials');
      }

      // Only after a valid password: block unverified accounts and resend link.
      // if (REQUIRE_EMAIL_VERIFICATION && !user.email_verified) {
      //   await client.query('ROLLBACK');
      //   try {
      //     await this.sendVerificationEmail(user.id, user.email, user.full_name);
      //   } catch {
      //     // Still block login even if resend fails.
      //   }
      //   throw new ForbiddenException(
      //     'EMAIL_NOT_VERIFIED: Please verify your email. We sent a fresh verification link.',
      //   );
      // }

      // Reset failed attempts
      await client.query(
        `
      UPDATE users
      SET failed_login_attempts = 0,
          locked_until = NULL,
          last_login_at = NOW()
      WHERE id = $1
      `,
        [user.id]
      );

      // Create tokens
      const accessToken = await this.jwtService.signAsync(
        {
          sub: user.id,
          email: user.email,
        },
        {
          expiresIn: '15m',
          secret:
            process.env.JWT_ACCESS_SECRET ||
            process.env.JWT_SECRET ||
            appConfiguration().JWT.SECRET,
        },
      );

      const refreshToken = await this.jwtService.signAsync(
        {
          sub: user.id,
        },
        {
          expiresIn: '7d',
          secret:
            process.env.JWT_REFRESH_SECRET ||
            process.env.JWT_SECRET ||
            appConfiguration().JWT.REFRESH_SECRET,
        },
      );

      const refreshTokenHash = await bcrypt.hash(refreshToken, 10);

      const sessionToken = randomUUID();
      const clientPlatform =
        (typeof req.headers['x-finos-client'] === 'string'
          ? req.headers['x-finos-client']
          : Array.isArray(req.headers['x-finos-client'])
            ? req.headers['x-finos-client'][0]
            : '') || '';
      const rawUa = req.headers['user-agent'] || null;
      const userAgent = clientPlatform
        ? `[finos:${clientPlatform}] ${rawUa || ''}`.trim()
        : rawUa;

      // Store session
      await client.query(
        `
      INSERT INTO user_sessions 
      (user_id, session_token, refresh_token, user_agent, ip_address, expires_at)
      VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '7 days')
      `,
        [
          user.id,
          sessionToken,
          refreshTokenHash,
          userAgent,
          req.ip,
        ],
      );

      await client.query('COMMIT');

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

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
      await this.userService.syncUsersToCache()
    }
  }

  async refreshToken(req: Request, res: Response) {
    const refreshToken =
      req.cookies?.['refreshToken'] || req.body?.refreshToken;
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token missing');
    }
    let payload: any;
    try {
      payload = await this.jwtService.verifyAsync(refreshToken, {
        secret:
          process.env.JWT_REFRESH_SECRET ||
          process.env.JWT_SECRET ||
          appConfiguration().JWT.REFRESH_SECRET,
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const sessionResult = await this.pgPool.query(
      `SELECT id, refresh_token FROM user_sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()
      ORDER BY created_at DESC`,
      [payload.sub]
    )

    if (!sessionResult.rowCount) {
      throw new UnauthorizedException('Session not found');
    }

    // A user can have multiple active sessions (different devices/logins).
    // Find the one whose stored hash matches this refresh token.
    let session: { id: string; refresh_token: string } | undefined;
    for (const candidate of sessionResult.rows) {
      if (await bcrypt.compare(refreshToken, candidate.refresh_token)) {
        session = candidate;
        break;
      }
    }

    if (!session) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const newAccessToken = await this.jwtService.signAsync(
      {
        sub: payload.sub,
      },
      {
        expiresIn: '15m',
        secret:
          process.env.JWT_ACCESS_SECRET ||
          process.env.JWT_SECRET ||
          appConfiguration().JWT.SECRET,
      },
    );

    // new refresh token rotating.
    const newRefreshToken = await this.jwtService.signAsync(
      {
        sub: payload.sub,
      },
      {
        expiresIn: '7d',
        secret:
          process.env.JWT_REFRESH_SECRET ||
          process.env.JWT_SECRET ||
          appConfiguration().JWT.REFRESH_SECRET,
      },
    );

    const newRefreshTokenHashed = await bcrypt.hash(newRefreshToken, 10);

    await this.pgPool.query(
      `UPDATE user_sessions
      SET session_token = $1,
          refresh_token = $2,
          updated_at = NOW()
      WHERE id = $3`,
      [newAccessToken, newRefreshTokenHashed, session.id]
    )


    res.cookie(REFRESH_COOKIE_NAME, newRefreshToken, refreshCookieOptions());
    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    }

  }



}
