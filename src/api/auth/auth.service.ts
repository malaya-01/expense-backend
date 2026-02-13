import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
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

@Injectable()
export class AuthService {
  constructor(
    @Inject('PG_POOL')
    private readonly pgPool: Pool,
    @Inject('CACHE_MANAGER')
    private readonly cacheManager: Cache,
    private readonly jwtService: JwtService
  ) { }


  async register(registerAuthDto: RegisterAuthDto) {
    const { full_name, email, password, confirmPassword } = registerAuthDto;

    if (password !== confirmPassword) {
      throw new BadRequestException('Password and confirm password do not match');
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const client = await this.pgPool.connect();
    try {
      const result = await client.query(
        `INSERT INTO users (full_name, email, password_hash) VALUES ($1, $2, $3)
        RETURNING id, full_name, email`,
        [full_name, email, passwordHash]
      )
      return result.rows[0];
    } catch (error: any) {
      if (error?.code === '23505') {
        throw new ConflictException('Email already exists');
      }
      throw new InternalServerErrorException('Failed to register user');
    } finally {
      client.release();
    }
  }


  async generateOtp(dto: OtpGenerateDto) {
    const { email } = dto;
    const user = await this.pgPool.query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    )
    if (user.rowCount === 0) {
      throw new BadRequestException('User with this email does not exist');
    }
    let otp = Math.floor(100000 + Math.random() * 900000).toString();
    const key = `${email}-otp`;
    await this.cacheManager.set(key, otp);
    // Here, you would typically send the OTP via email or SMS

    console.log(`OTP for ${email} is ${otp}`); // For demonstration purposes only
    return { message: 'OTP generated and sent successfully', otp }; // Return OTP for testing purposes
  }

  async resetPassword(dto: PasswordResetDto) {
    const { email, newPassword, confirmNewPassword, otp } = dto;

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

  async login(dto: LoginAuthDto, req: Request) {
    const { email, password } = dto;

    const client = await this.pgPool.connect();

    try {
      await client.query('BEGIN');

      const userResult = await client.query(
        `
      SELECT id, email, password_hash, full_name, 
             email_verified, failed_login_attempts, 
             locked_until, deleted_at
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

      // Email verification check
      // if (!user.email_verified) {
      //   throw new ForbiddenException('Email not verified.');
      // }

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
          expiresIn: '15 min',
          secret: process.env.JWT_ACCESS_SECRET,
        },
      );

      const refreshToken = await this.jwtService.signAsync(
        {
          sub: user.id,
        },
        {
          expiresIn: '7d',
          secret: process.env.JWT_REFRESH_SECRET,
        },
      );

      const refreshTokenHash = await bcrypt.hash(refreshToken, 10);

      // Store session
      await client.query(
        `
      INSERT INTO user_sessions 
      (user_id, session_token, refresh_token, user_agent, ip_address, expires_at)
      VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '7 days')
      `,
        [
          user.id,
          accessToken,
          refreshTokenHash,
          req.headers['user-agent'] || null,
          req.ip,
        ],
      );

      await client.query('COMMIT');

      return {
        accessToken,
        refreshToken,
      };

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async refreshToken(req: Request, res: Response) {
    const refreshToken = req.cookies['refreshToken'];
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token missing');
    }
    let payload: any;
    try {
      payload = await this.jwtService.verifyAsync(refreshToken, {
        secret: process.env.JWT_REFRESH_SECRET,
      })
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const sessionResult = await this.pgPool.query(
      `SELECT id, refresh_token FROM user_sessions
      WHERE user_id = $1 AND revocked_at IS NULL AND expires_at > NOW()`,
      [payload.sub]
    )

    if (!sessionResult.rowCount) {
      throw new UnauthorizedException('Session not found');
    }

    const session = sessionResult.rows[0];
    const isRefreshTokenValid = await bcrypt.compare(refreshToken, session.refresh_token);

    if (!isRefreshTokenValid) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (new Date(session.revoked_at) < new Date()) {
      throw new ForbiddenException('Refresh token expired');
    }

    // new access tokens
    const newAccessToken = await this.jwtService.signAsync({
      sub: payload.sub,
    }, {
      expiresIn: '15m',
      secret: process.env.JWT_ACCESS_SECRET,
    });

    // new refresh token rotating.
    const newRefreshToken = await this.jwtService.signAsync({
      sub: payload.sub,
    }, {
      expiresIn: '7d',
      secret: process.env.JWT_REFRESH_SECRET,
    });

    const newRefreshTokenHashed = await bcrypt.hash(refreshToken, 10);

    await this.pgPool.query(
      `UPDATE user_sessions
      SET session_token = $1,
          refresh_token = $2,
          updated_at = NOW()
      WHERE id = $3`,
      [newAccessToken, newRefreshTokenHashed, session.id]
    )


    res.cookie('refreshToken', newRefreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });
    return {
      accessToken: newAccessToken,
    }

  }



}
