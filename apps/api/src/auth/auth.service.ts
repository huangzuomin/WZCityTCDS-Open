import { Inject, Injectable, Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { and, count, eq, isNull } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../db/db.module';
import { users } from '../db/schema';
import { hashPassword, verifyPassword } from '../common/crypto';
import type { Role } from './decorators';

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /** 首次启动兜底建号，避免系统无人可登录 */
  async onModuleInit(): Promise<void> {
    const [{ value: total }] = await this.db
      .select({ value: count() })
      .from(users)
      .where(isNull(users.deletedAt));
    if (total > 0) return;

    const password = this.config.get<string>('DEFAULT_ADMIN_PASSWORD', 'ssot@2026');
    await this.db.insert(users).values({
      username: 'admin',
      displayName: '系统管理员',
      passwordHash: hashPassword(password),
      role: 'admin',
      status: 'active',
    });
    this.logger.warn(`已初始化管理员账号 admin / ${password}（请登录后立即修改）`);
  }

  async login(username: string, password: string) {
    const [row] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.username, username), isNull(users.deletedAt)))
      .limit(1);

    if (!row || !verifyPassword(password, row.passwordHash)) {
      throw new UnauthorizedException('用户名或密码错误');
    }
    if (row.status !== 'active') throw new UnauthorizedException('账号已停用');

    await this.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, row.id));

    const token = await this.jwt.signAsync({
      sub: row.id,
      username: row.username,
      role: row.role,
    });

    return {
      token,
      expiresIn: this.config.get<string>('JWT_EXPIRES_IN', '12h'),
      user: {
        id: row.id,
        username: row.username,
        displayName: row.displayName,
        role: row.role as Role,
      },
    };
  }

  async profile(userId: number) {
    const [row] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!row) throw new UnauthorizedException('用户不存在');
    return {
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      role: row.role as Role,
      lastLoginAt: row.lastLoginAt,
    };
  }

  async changePassword(userId: number, oldPassword: string, newPassword: string) {
    const [row] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!row || !verifyPassword(oldPassword, row.passwordHash)) {
      throw new UnauthorizedException('原密码不正确');
    }
    await this.db
      .update(users)
      .set({ passwordHash: hashPassword(newPassword) })
      .where(eq(users.id, userId));
    return { updated: true };
  }
}
