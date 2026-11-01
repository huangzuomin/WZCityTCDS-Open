import type { ProbeModelConfig } from './observatory.types';

/**
 * Observatory 全局配置。
 * - 事实页生产域为 66wz.com 的子域（用户确认），故用后缀匹配覆盖任意子域。
 * - 探针模型矩阵默认仅 Doubao(Ark)；但可被 system_settings(PROBE_MODELS) 覆盖，
 *   由 ProbeModelConfigService 读写，后台「设置」页可编辑。
 * - API Key 仅从环境变量读取（apiKeyEnv），禁止硬编码/落库。
 */
export const OBSERVATORY_CONFIG = {
  domainSuffix: '66wz.com',
  factPathPrefix: '/fact/',
} as const;

/** system_settings 中存储探针模型矩阵的键 */
export const PROBE_MODELS_SETTING_KEY = 'PROBE_MODELS';

/** 默认模型矩阵（无 system_settings 或解析失败时回落） */
export function defaultProbeModels(): ProbeModelConfig[] {
  return [
    {
      id: 'ark-doubao',
      provider: 'ark',
      label: '豆包',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3/responses',
      model: 'doubao-seed-2-1-pro-260628',
      apiKeyEnv: 'ARK_API_KEY',
      enabled: true,
    },
  ];
}
