import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod.pipe';
import { AuthService } from './auth.service';
import { CurrentUser, Public, type CurrentUserPayload } from './decorators';

const loginSchema = z.object({
  username: z.string().min(2).max(64),
  password: z.string().min(6).max(128),
});

const passwordSchema = z.object({
  oldPassword: z.string().min(6).max(128),
  newPassword: z.string().min(6).max(128),
});

@Controller('auth')
export class AuthController {
  constructor(private readonly service: AuthService) {}

  @Public()
  @Post('login')
  login(@Body(new ZodValidationPipe(loginSchema)) dto: { username: string; password: string }) {
    return this.service.login(dto.username, dto.password);
  }

  @Get('me')
  me(@CurrentUser() user: CurrentUserPayload) {
    return this.service.profile(user.id);
  }

  @Patch('password')
  changePassword(
    @CurrentUser() user: CurrentUserPayload,
    @Body(new ZodValidationPipe(passwordSchema)) dto: { oldPassword: string; newPassword: string },
  ) {
    return this.service.changePassword(user.id, dto.oldPassword, dto.newPassword);
  }
}
