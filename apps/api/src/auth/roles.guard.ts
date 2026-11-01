import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY, type Role } from './decorators';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;

    const request = context.switchToHttp().getRequest<{ user?: { role: Role } }>();
    const role = request.user?.role;
    if (!role) throw new ForbiddenException('缺少用户角色信息');
    if (role === 'admin') return true;
    if (!required.includes(role)) {
      throw new ForbiddenException(`需要角色：${required.join(' / ')}`);
    }
    return true;
  }
}
