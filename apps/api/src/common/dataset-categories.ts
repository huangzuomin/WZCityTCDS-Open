/**
 * v2 语料域 → 全局分类的关联工具。
 * 实体全局唯一后，「某语料域下的实体」=「category_id ∈ 该库关联分类集合」的实体。
 */
import { eq } from 'drizzle-orm';
import { datasetCategories } from '../db/schema';
import type { Db } from '../db/db.module';

export async function linkedCategoryIds(db: Db, datasetId: number): Promise<number[]> {
  const rows = await db
    .select({ id: datasetCategories.categoryId })
    .from(datasetCategories)
    .where(eq(datasetCategories.datasetId, datasetId));
  return rows.map((r) => Number(r.id));
}
