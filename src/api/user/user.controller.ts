import { Controller, Get, Req } from '@nestjs/common';
import { UserService } from './user.service';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Request } from 'express';



@ApiBearerAuth('bearer')
@Controller('user')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get()
  findCurrent(@Req() req: Request) {
    return this.userService.findOne((req as any).user.id as string);
  }
}
