export type DatasetStatus = 'active' | 'archived';
export type PublishStatus = 'draft' | 'published' | 'archived';
export type EnableStatus = 'active' | 'disabled';

export type FieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'date'
  | 'select'
  | 'multiselect'
  | 'boolean'
  | 'url'
  | 'json'
  | 'entity_ref';

export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  text: '单行文本',
  textarea: '多行文本',
  number: '数字',
  date: '日期',
  select: '单选',
  multiselect: '多选',
  boolean: '是否',
  url: '链接',
  json: 'JSON',
  entity_ref: '实体关联',
};

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  nextCursor?: number | null;
}

export interface Dataset {
  id: number;
  code: string;
  name: string;
  description: string | null;
  status: DatasetStatus;
  sort: number;
  createdAt: string;
  updatedAt: string;
}

export interface Category {
  id: number;
  datasetId: number;
  parentId: number | null;
  code: string;
  name: string;
  description: string | null;
  sort: number;
  status: EnableStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CategoryNode {
  id: number;
  datasetId: number;
  parentId: number | null;
  code: string;
  name: string;
  /** 树接口不返回描述，编辑时另行拉取 */
  description?: string | null;
  sort: number;
  status: string;
  children: CategoryNode[];
}

export interface FieldOption {
  value: string;
  label: string;
}

export interface FieldDef {
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
  status: EnableStatus;
}

export interface EntityListItem {
  id: number;
  urn: string;
  name: string;
  slug: string;
  status: PublishStatus;
  revision: number;
  datasetId: number;
  categoryId: number;
  datasetName: string | null;
  datasetCode: string | null;
  categoryName: string | null;
  factCount: number | null;
  updatedAt: string;
}

export interface EntityAlias {
  id: number;
  entityId: number;
  alias: string;
  source: string | null;
  createdAt: string;
}

export interface EntityDetail {
  id: number;
  datasetId: number;
  categoryId: number;
  originDatasetId: number | null;
  urn: string;
  name: string;
  slug: string;
  lede: string | null;
  seedSource: string | null;
  attrsJson: Record<string, unknown> | null;
  status: PublishStatus;
  revision: number;
  fields: FieldDef[];
  aliases: EntityAlias[];
  updatedAt: string;
}
