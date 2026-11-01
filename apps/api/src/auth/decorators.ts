import { SetMetadata } from '@nestjs/common';
import { ExecutionContext, createParamDecorator } from '@nestjs/common';

export const ROLES_KEY = 'roles';
export const IS_PUBLIC_KEY = 'isPublic';

/** 四级角色：admin 全权限 / editor 增删改 / reviewer 审核 / viewer 只读 */
export type Role = 'admin' | 'editor' | 'reviewer' | 'viewer';

/** 标记该路由无需登录（展示层公开读接口、登录接口） */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** 限制可访问角色；不写则只要登录即可 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export interface CurrentUserPayload {
  id: number;
  username: string;
  displayName: string | null;
  role: Role;
}

export const CurrentUser = createParamDecorator(
  (data: keyof CurrentUserPayload | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<{ user?: CurrentUserPayload }>();
    const user = request.user;
    if (!user) return undefined;
    return data ? user[data] : user;
  },
);
