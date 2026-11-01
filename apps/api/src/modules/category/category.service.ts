import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, count, eq, like, or } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../../db/db.module';
import { categories, entities } from '../../db/schema';
import {
  CategoryTreeNode,
  CreateCategoryDto,
  ListCategoryQuery,
  UpdateCategoryDto,
} from './category.dto';

type CategoryRow = typeof categories.$inferSelect;

@Injectable()
export class CategoryService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(query: ListCategoryQuery) {
    const where = and(
      query.status ? eq(categories.status, query.status) : undefined,
      query.keyword
        ? or(like(categories.name, `%${query.keyword}%`), like(categories.code, `%${query.keyword}%`))
        : undefined,
    );

    const rows = await this.db
      .select()
      .from(categories)
      .where(where)
      .orderBy(asc(categories.sort), asc(categories.id));

    if (!query.tree) return { items: rows, total: rows.length };
    return { items: this.buildTree(rows), total: rows.length };
  }

  async findOne(id: number) {
    const [row] = await this.db.select().from(categories).where(eq(categories.id, id)).limit(1);
    if (!row) throw new NotFoundException('类别不存在');
    return row;
  }

  async create(dto: CreateCategoryDto) {
    if (dto.parentId) {
      const parent = await this.findOne(dto.parentId);
      if (parent.status === 'disabled') {
        throw new BadRequestException('父类别已停用，不能作为父级');
      }
    }

    const [exist] = await this.db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.code, dto.code))
      .limit(1);
    if (exist) throw new ConflictException(`code 全局已存在：${dto.code}`);

    const [created] = await this.db.insert(categories).values({
      parentId: dto.parentId ?? null,
      code: dto.code,
      name: dto.name,
      description: dto.description ?? null,
      sort: dto.sort ?? 0,
      status: dto.status ?? 'active',
    });
    return this.findOne(Number(created.insertId));
  }

  async update(id: number, dto: UpdateCategoryDto) {
    const current = await this.findOne(id);

    if (dto.parentId !== undefined && dto.parentId !== null) {
      if (dto.parentId === id) throw new BadRequestException('父类别不能是自己');
      const chain = await this.getChain(dto.parentId);
      if (chain.some((c) => c.id === id)) {
        throw new BadRequestException('不能将类别移动到自己的子类别下（会形成环）');
      }
    }

    await this.db
      .update(categories)
      .set({ ...dto, parentId: dto.parentId === undefined ? current.parentId : dto.parentId })
      .where(eq(categories.id, id));
    return this.findOne(id);
  }

  async remove(id: number) {
    await this.findOne(id);
    const [{ value: children }] = await this.db
      .select({ value: count() })
      .from(categories)
      .where(eq(categories.parentId, id));
    const [{ value: entityCount }] = await this.db
      .select({ value: count() })
      .from(entities)
      .where(eq(entities.categoryId, id));

    if (children > 0 || entityCount > 0) {
      await this.db.update(categories).set({ status: 'disabled' }).where(eq(categories.id, id));
      return { deleted: false, disabled: true, children, entityCount };
    }
    await this.db.delete(categories).where(eq(categories.id, id));
    return { deleted: true, disabled: false };
  }

  /** 从根到叶的类别链（供字段继承解析） */
  async getChain(categoryId: number): Promise<CategoryRow[]> {
    const chain: CategoryRow[] = [];
    let cursor: number | null = categoryId;
    let guard = 0;

    while (cursor && guard < 32) {
      const row = await this.findOne(cursor);
      chain.unshift(row);
      cursor = row.parentId;
      guard += 1;
    }
    return chain;
  }

  private buildTree(rows: CategoryRow[]): CategoryTreeNode[] {
    const map = new Map<number, CategoryTreeNode>();
    for (const r of rows) {
      map.set(r.id, {
        id: r.id,
        parentId: r.parentId,
        code: r.code,
        name: r.name,
        sort: r.sort,
        status: r.status,
        children: [],
      });
    }
    const roots: CategoryTreeNode[] = [];
    for (const node of map.values()) {
      const parent = node.parentId ? map.get(node.parentId) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    const sortRec = (nodes: CategoryTreeNode[]) => {
      nodes.sort((a, b) => a.sort - b.sort || a.id - b.id);
      nodes.forEach((n) => sortRec(n.children));
    };
    sortRec(roots);
    return roots;
  }
}
