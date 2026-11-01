import { z } from 'zod';
import { FIELD_TYPE, type FieldType } from './constants.js';

/** 字段定义（后台配置，驱动表单 + 校验 + 列表） */
export interface FieldDefDto {
  id: number;
  categoryId: number;
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  inheritable: boolean;
  options: FieldOption[] | null;
  defaultValue: unknown;
  placeholder: string | null;
  helpText: string | null;
  groupName: string | null;
  sort: number;
  searchable: boolean;
  status: 'active' | 'disabled';
}

export interface FieldOption {
  value: string;
  label: string;
}

export const fieldDefTypeSchema = z.enum(FIELD_TYPE);

export const fieldDefCreateSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'key 只能包含字母、数字、下划线，且以字母开头'),
  label: z.string().min(1).max(64),
  type: fieldDefTypeSchema,
  required: z.boolean().default(false),
  inheritable: z.boolean().default(true),
  options: z.array(z.object({ value: z.string(), label: z.string() })).nullable().default(null),
  defaultValue: z.unknown().nullable().default(null),
  placeholder: z.string().max(128).nullable().default(null),
  helpText: z.string().max(255).nullable().default(null),
  groupName: z.string().max(64).nullable().default(null),
  sort: z.number().int().default(0),
  searchable: z.boolean().default(false),
  status: z.enum(['active', 'disabled']).default('active'),
});

export type FieldDefCreateInput = z.infer<typeof fieldDefCreateSchema>;

/** 根据字段定义动态生成 Zod 校验器 —— 后台自定义字段的核心 */
export function buildAttrsSchema(fields: Pick<FieldDefDto, 'key' | 'type' | 'required' | 'options'>[]) {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const f of fields) {
    let validator: z.ZodTypeAny;

    switch (f.type) {
      case 'number':
        validator = z.coerce.number();
        break;
      case 'boolean':
        validator = z.coerce.boolean();
        break;
      case 'date':
        validator = z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD')
          .or(z.date())
          .nullable();
        break;
      case 'select': {
        const values = (f.options ?? []).map((o) => o.value);
        validator = values.length ? z.enum(values as [string, ...string[]]) : z.string();
        break;
      }
      case 'multiselect': {
        const values = (f.options ?? []).map((o) => o.value);
        validator = values.length
          ? z.array(z.enum(values as [string, ...string[]]))
          : z.array(z.string());
        break;
      }
      case 'url':
        validator = z.string().url().max(1024);
        break;
      case 'json':
        validator = z.unknown();
        break;
      case 'entity_ref':
        validator = z.coerce.number().int().positive();
        break;
      case 'textarea':
        validator = z.string().max(20000);
        break;
      default:
        validator = z.string().max(2000);
    }

    shape[f.key] = f.required ? validator : validator.nullable().optional();
  }

  // 未定义字段允许存放，避免老数据因删字段而校验失败（strict 由调用方决定）
  return z.object(shape).passthrough();
}

/**
 * 沿类别继承链（根 → 叶）合并字段：
 * - 祖先字段仅在 inheritable 时才下传
 * - 同 key 由更靠近叶子的层级覆写
 */
export function mergeInheritedFields(
  chain: { categoryId: number; fields: FieldDefDto[] }[],
  targetCategoryId: number,
): FieldDefDto[] {
  const map = new Map<string, FieldDefDto>();
  for (const level of chain) {
    const isSelf = level.categoryId === targetCategoryId;
    for (const f of level.fields) {
      if (!isSelf && !f.inheritable) continue;
      map.set(f.key, { ...f });
    }
  }
  return [...map.values()].sort((a, b) => a.sort - b.sort || a.key.localeCompare(b.key));
}
