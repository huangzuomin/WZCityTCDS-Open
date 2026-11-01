import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { buildAttrsSchema, FieldDefDto, mergeInheritedFields } from '@ssot/shared';
import { DRIZZLE, type Db } from '../../db/db.module';
import { fieldDefs } from '../../db/schema';
import { CategoryService } from '../category/category.service';
import { CreateFieldDefDto, UpdateFieldDefDto } from './field-def.dto';

type FieldDefRow = typeof fieldDefs.$inferSelect;

@Injectable()
export class FieldDefService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly categoryService: CategoryService,
  ) {}

  private toDto(row: FieldDefRow): FieldDefDto {
    let defaultValue: unknown = null;
    if (row.defaultValue) {
      try {
        defaultValue = JSON.parse(row.defaultValue);
      } catch {
        defaultValue = row.defaultValue;
      }
    }
    return {
      id: row.id,
      categoryId: row.categoryId,
      key: row.key,
      label: row.label,
      type: row.type,
      required: row.required,
      inheritable: row.inheritable,
      options: row.optionsJson ?? null,
      defaultValue,
      placeholder: row.placeholder,
      helpText: row.helpText,
      groupName: row.groupName,
      sort: row.sort,
      searchable: row.searchable,
      status: row.status,
    };
  }

  async listByCategory(categoryId: number) {
    const rows = await this.db
      .select()
      .from(fieldDefs)
      .where(eq(fieldDefs.categoryId, categoryId))
      .orderBy(asc(fieldDefs.sort), asc(fieldDefs.id));
    return rows.map((r) => this.toDto(r));
  }

  /** 解析某类别最终生效字段（含继承） */
  async resolve(categoryId: number): Promise<FieldDefDto[]> {
    const chain = await this.categoryService.getChain(categoryId);
    const ids = chain.map((c) => c.id);
    const rows = await this.db
      .select()
      .from(fieldDefs)
      .where(and(inArray(fieldDefs.categoryId, ids), eq(fieldDefs.status, 'active')))
      .orderBy(asc(fieldDefs.sort), asc(fieldDefs.id));

    const grouped = chain.map((level) => ({
      categoryId: level.id,
      fields: rows.filter((r) => r.categoryId === level.id).map((r) => this.toDto(r)),
    }));

    return mergeInheritedFields(grouped, categoryId);
  }

  /** 生成该类别自定义字段的 Zod 校验器 */
  async buildValidator(categoryId: number) {
    const fields = await this.resolve(categoryId);
    return { fields, schema: buildAttrsSchema(fields) };
  }

  async findOne(id: number) {
    const [row] = await this.db.select().from(fieldDefs).where(eq(fieldDefs.id, id)).limit(1);
    if (!row) throw new NotFoundException('字段定义不存在');
    return this.toDto(row);
  }

  async create(dto: CreateFieldDefDto) {
    await this.categoryService.findOne(dto.categoryId);

    const [exist] = await this.db
      .select({ id: fieldDefs.id })
      .from(fieldDefs)
      .where(and(eq(fieldDefs.categoryId, dto.categoryId), eq(fieldDefs.key, dto.key)))
      .limit(1);
    if (exist) throw new ConflictException(`key 在该类别下已存在：${dto.key}`);

    const [created] = await this.db.insert(fieldDefs).values({
      categoryId: dto.categoryId,
      key: dto.key,
      label: dto.label,
      type: dto.type,
      required: dto.required ?? false,
      inheritable: dto.inheritable ?? true,
      optionsJson: dto.options ?? null,
      defaultValue: dto.defaultValue === null || dto.defaultValue === undefined
        ? null
        : JSON.stringify(dto.defaultValue),
      placeholder: dto.placeholder ?? null,
      helpText: dto.helpText ?? null,
      groupName: dto.groupName ?? null,
      sort: dto.sort ?? 0,
      searchable: dto.searchable ?? false,
    });
    return this.findOne(Number(created.insertId));
  }

  async update(id: number, dto: UpdateFieldDefDto) {
    await this.findOne(id);
    const patch: Partial<typeof fieldDefs.$inferInsert> = {};
    if (dto.label !== undefined) patch.label = dto.label;
    if (dto.type !== undefined) patch.type = dto.type;
    if (dto.required !== undefined) patch.required = dto.required;
    if (dto.inheritable !== undefined) patch.inheritable = dto.inheritable;
    if (dto.options !== undefined) patch.optionsJson = dto.options;
    if (dto.defaultValue !== undefined) patch.defaultValue = JSON.stringify(dto.defaultValue);
    if (dto.placeholder !== undefined) patch.placeholder = dto.placeholder;
    if (dto.helpText !== undefined) patch.helpText = dto.helpText;
    if (dto.groupName !== undefined) patch.groupName = dto.groupName;
    if (dto.sort !== undefined) patch.sort = dto.sort;
    if (dto.searchable !== undefined) patch.searchable = dto.searchable;
    if (dto.status !== undefined) patch.status = dto.status;

    await this.db.update(fieldDefs).set(patch).where(eq(fieldDefs.id, id));
    return this.findOne(id);
  }

  async remove(id: number) {
    await this.findOne(id);
    await this.db.delete(fieldDefs).where(eq(fieldDefs.id, id));
    return { deleted: true };
  }
}
