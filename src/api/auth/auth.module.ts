import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtModule } from '@nestjs/jwt';
import appConfiguration from 'src/app.configuration';
import { UserModule } from '../user/user.module';

@Module({
  imports:[
    JwtModule.register({
      secret: appConfiguration().JWT.SECRET,
      signOptions: { expiresIn: '15m' },
    }),
    UserModule
  ],
  controllers: [AuthController],
  providers: [AuthService],
  exports: [JwtModule],
})
export class AuthModule {}
