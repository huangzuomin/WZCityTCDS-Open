import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, count, desc, eq, isNull, like } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../../db/db.module';
import { users } from '../../db/schema';
import { hashPassword } from '../../common/crypto';
import type { CreateUserDto, ListUserQuery, UpdateUserDto } from './user.dto';

@Injectable()
export class UserService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(query: ListUserQuery) {
    const where = and(
      isNull(users.deletedAt),
      query.role ? eq(users.role, query.role) : undefined,
      query.keyword ? like(users.username, `%${query.keyword}%`) : undefined,
    );
    const [{ value: total }] = await this.db.select({ value: count() }).from(users).where(where);
    const items = await this.db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        role: users.role,
        status: users.status,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(where)
      .orderBy(desc(users.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  async create(dto: CreateUserDto) {
    const [dup] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, dto.username))
      .limit(1);
    if (dup) throw new ConflictException('用户名已存在');

    const [ins] = await this.db.insert(users).values({
      username: dto.username,
      passwordHash: hashPassword(dto.password),
      displayName: dto.displayName ?? null,
      role: dto.role,
      status: dto.status,
    });
    return this.findOne(Number(ins.insertId));
  }

  async update(id: number, dto: UpdateUserDto) {
    await this.findOne(id);
    const patch: Partial<typeof users.$inferInsert> = {};
    if (dto.displayName !== undefined) patch.displayName = dto.displayName ?? null;
    if (dto.role !== undefined) patch.role = dto.role;
    if (dto.status !== undefined) patch.status = dto.status;
    if (dto.password) patch.passwordHash = hashPassword(dto.password);
    if (Object.keys(patch).length) {
      await this.db.update(users).set(patch).where(eq(users.id, id));
    }
    return this.findOne(id);
  }

  async remove(id: number) {
    await this.findOne(id);
    await this.db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, id));
    return { deleted: true };
  }

  async findOne(id: number) {
    const [row] = await this.db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        role: users.role,
        status: users.status,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(and(eq(users.id, id), isNull(users.deletedAt)))
      .limit(1);
    if (!row) throw new NotFoundException('用户不存在');
    return row;
  }
}
