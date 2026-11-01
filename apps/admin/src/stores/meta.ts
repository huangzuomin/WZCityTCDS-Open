import { defineStore } from 'pinia';
import { categoryApi, datasetApi } from '@/api';
import type { Category, CategoryNode, Dataset } from '@/types';

interface MetaState {
  datasets: Dataset[];
  /** v2：全局分类（平铺） */
  categories: Category[];
  /** v2：全局分类树 */
  trees: CategoryNode[];
  loaded: boolean;
}

export const useMetaStore = defineStore('meta', {
  state: (): MetaState => ({
    datasets: [],
    categories: [],
    trees: [],
    loaded: false,
  }),
  getters: {
    datasetOptions: (state) => state.datasets.map((d) => ({ value: d.id, label: d.name })),
    /** v2：分类全局化，忽略 datasetId 参数（兼容旧调用） */
    flatCategories: () => (datasetId: number) => [],
    /** v2：分类全局化，忽略 datasetId 参数 */
    treeOf: (state) => (datasetId: number) => state.trees,
  },
  actions: {
    async ensureLoaded() {
      if (this.loaded) return;
      await Promise.all([this.loadDatasets(), this.loadGlobalTree()]);
      this.loaded = true;
    },
    async loadDatasets() {
      const res = await datasetApi.list({ pageSize: 200 });
      this.datasets = res.items;
    },
    /** v2：一次载入全局分类树 */
    async loadGlobalTree() {
      const [flat, tree] = await Promise.all([
        categoryApi.list({}),
        categoryApi.list({ tree: true }),
      ]);
      this.categories = flat.items as Category[];
      this.trees = tree.items as CategoryNode[];
    },
    /** 兼容旧调用：v2 分类全局化，datasetId 忽略 */
    async loadCategories(datasetId?: number) {
      await this.loadGlobalTree();
    },
    /** 兼容旧调用：v2 分类全局化，datasetId 忽略 */
    async loadTree(datasetId?: number) {
      await this.loadGlobalTree();
    },
    /** 把树拍平成 el-cascader 需要的层级数据（v2 全局，忽略 datasetId） */
    categoryCascaderOptions(datasetId?: number): { value: number; label: string; children?: unknown[] }[] {
      const build = (nodes: CategoryNode[]): { value: number; label: string; children?: unknown[] }[] =>
        nodes.map((n) => ({
          value: n.id,
          label: n.name,
          ...(n.children?.length ? { children: build(n.children) } : {}),
        }));
      return build(this.trees);
    },
    categoryLabel(categoryId: number): string {
      return this.categories.find((c) => c.id === categoryId)?.name ?? String(categoryId);
    },
  },
});
