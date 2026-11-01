import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../../db/db.module';
import { systemSettings } from '../../db/schema';
import { defaultProbeModels, PROBE_MODELS_SETTING_KEY } from './observatory.config';
import type { ProbeModelConfig } from './observatory.types';

/**
 * 探针模型矩阵配置：存于 system_settings(PROBE_MODELS) 的 JSON 数组，
 * 后台「设置」页可编辑；缺失/损坏时回落 defaultProbeModels()。
 * API Key 不在本表，调用时由 apiKeyEnv 从环境变量读取。
 */
@Injectable()
export class ProbeModelConfigService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(): Promise<ProbeModelConfig[]> {
    const [row] = await this.db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.skey, PROBE_MODELS_SETTING_KEY))
      .limit(1);
    if (!row) return defaultProbeModels();
    try {
      const arr = JSON.parse(row.svalue) as ProbeModelConfig[];
      // 只保留统一联网搜索通道（其它厂商通道已下线，不再暴露到设置页）
      const web = Array.isArray(arr) ? arr.filter((m) => m.provider === 'websearch') : [];
      return web.length ? web : defaultProbeModels();
    } catch {
      return defaultProbeModels();
    }
  }

  async enabled(): Promise<ProbeModelConfig[]> {
    return (await this.list()).filter((m) => m.enabled);
  }

  /**
   * 保存探针模型配置：强制只保留统一联网搜索一条（忽略其它厂商）。
   * 设置页不再支持新增厂商 / 删除。
   */
  async save(models: ProbeModelConfig[]): Promise<void> {
    const web = (Array.isArray(models) ? models : [])
      .filter((m) => m.provider === 'websearch')
      .map((m) => ({ ...m, provider: 'websearch' as const, id: 'websearch-unified' }));
    const finalModels = web.length ? web : defaultProbeModels();
    await this.db
      .insert(systemSettings)
      .values({ skey: PROBE_MODELS_SETTING_KEY, svalue: JSON.stringify(finalModels) })
      .onDuplicateKeyUpdate({ set: { svalue: JSON.stringify(finalModels) } });
  }
}
