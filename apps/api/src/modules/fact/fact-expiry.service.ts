import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../../db/db.module';
import { systemSettings } from '../../db/schema';
import { todayInShanghai } from '@ssot/shared';
import { FactService } from './fact.service';

/** 上次执行日期（北京时间），落在 system_setting，保证「每天最多跑一次」 */
const LAST_RUN_KEY = 'FACT_EXPIRY_LAST_RUN';

/**
 * 事实到期退役任务：进程内每小时检查一次，当天首次触发时把 valid_to 早于今日的
 * 现行事实批量转 archived（写 retire 变更留痕）。查询侧另有 currentByEntity 的
 * 查询时判定兜底，二者口径一致。
 */
@Injectable()
export class FactExpiryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FactExpiryService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly facts: FactService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), 3_600_000);
    void this.tick();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    try {
      const today = todayInShanghai();
      const [row] = await this.db.select().from(systemSettings).where(eq(systemSettings.skey, LAST_RUN_KEY)).limit(1);
      if (row?.svalue === today) return;
      const { retired } = await this.facts.retireExpired();
      await this.db
        .insert(systemSettings)
        .values({ skey: LAST_RUN_KEY, svalue: today })
        .onDuplicateKeyUpdate({ set: { svalue: today } });
      if (retired) this.logger.log(`[fact-expiry] 到期退役 ${retired} 条事实`);
    } catch (err) {
      this.logger.error(`[fact-expiry] 执行异常：${(err as Error).message}`);
    }
  }
}
