import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { asc, desc, eq } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../../db/db.module';
import { datasets, systemSettings } from '../../db/schema';
import { loadSources, type NewsSource } from './news-sources';
import { NewsService } from './news.service';
import {
  DEFAULT_NEWS_SCHEDULE,
  NEWS_RUNS_KEY,
  NEWS_SCHEDULES_KEY,
  NEWS_SCHEDULE_KEY,
  NEWS_STATES_KEY,
  type NewsRunRecord,
  type NewsSchedule,
  type NewsScheduleState,
} from './news.types';

const MAX_HISTORY = 100;

const EMPTY_STATE: NewsScheduleState = { lastRunAt: null, lastStatus: null, lastError: null, nextRunAt: null, running: false };

/**
 * 实时新闻任务计划（多计划）：每个计划绑定一个新闻源，按周期把该源入库并跑生产线。
 * 配置/状态/执行历史都落在 system_setting（不新增表），进程内每 60s 检查一次。
 */
@Injectable()
export class NewsScheduleService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NewsScheduleService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly news: NewsService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), 60_000);
    void (async () => {
      await this.migrateLegacySchedule();
      await this.resetStaleRunning();
      await this.tick(); // 启动时立即校准一次 nextRunAt
    })();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** 历史遗留的单计划迁移到多计划列表 */
  private async migrateLegacySchedule(): Promise<void> {
    const [list] = await this.db.select().from(systemSettings).where(eq(systemSettings.skey, NEWS_SCHEDULES_KEY)).limit(1);
    if (list) return;
    const [legacy] = await this.db.select().from(systemSettings).where(eq(systemSettings.skey, NEWS_SCHEDULE_KEY)).limit(1);
    if (!legacy) return;
    try {
      const old = JSON.parse(legacy.svalue) as Partial<NewsSchedule> & { sourceId?: string };
      const migrated: NewsSchedule = {
        ...DEFAULT_NEWS_SCHEDULE,
        ...old,
        id: Date.now(),
        name: old.name || '原·默认计划',
        sourceId: old.sourceId || '',
      };
      await this.db
        .insert(systemSettings)
        .values({ skey: NEWS_SCHEDULES_KEY, svalue: JSON.stringify([migrated]) })
        .onDuplicateKeyUpdate({ set: { svalue: JSON.stringify([migrated]) } });
      this.logger.log('[news-schedule] 已迁移历史单计划到多计划列表');
    } catch {
      // 忽略坏数据
    }
  }

  private async resetStaleRunning(): Promise<void> {
    const states = await this.readStates();
    let dirty = false;
    for (const id of Object.keys(states)) {
      if (states[id].running) {
        states[id] = { ...states[id], running: false, lastStatus: 'error', lastError: '执行被中断（应用重启）' };
        dirty = true;
      }
    }
    if (dirty) await this.saveStates(states);
    // 重启后遗留 running 的执行记录收尾为 error，避免历史里永久显示「执行中」
    const runs = await this.readRuns();
    let runDirty = false;
    for (const r of runs) {
      if (r.status === 'running') {
        r.status = 'error';
        r.error = r.error || '应用重启中断';
        r.finishedAt = r.finishedAt ?? new Date().toISOString();
        runDirty = true;
      }
    }
    if (runDirty) await this.saveRuns(runs);
  }

  // ---------------------------------------------------------------- 配置读写

  private async readSchedules(): Promise<NewsSchedule[]> {
    const [row] = await this.db.select().from(systemSettings).where(eq(systemSettings.skey, NEWS_SCHEDULES_KEY)).limit(1);
    if (!row) return [];
    try {
      const arr = JSON.parse(row.svalue) as NewsSchedule[];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  private async saveSchedules(list: NewsSchedule[]): Promise<void> {
    await this.db
      .insert(systemSettings)
      .values({ skey: NEWS_SCHEDULES_KEY, svalue: JSON.stringify(list) })
      .onDuplicateKeyUpdate({ set: { svalue: JSON.stringify(list) } });
  }

  private async readStates(): Promise<Record<string, NewsScheduleState>> {
    const [row] = await this.db.select().from(systemSettings).where(eq(systemSettings.skey, NEWS_STATES_KEY)).limit(1);
    if (!row) return {};
    try {
      const v = JSON.parse(row.svalue) as Record<string, NewsScheduleState>;
      return v && typeof v === 'object' ? v : {};
    } catch {
      return {};
    }
  }

  private async saveStates(states: Record<string, NewsScheduleState>): Promise<void> {
    await this.db
      .insert(systemSettings)
      .values({ skey: NEWS_STATES_KEY, svalue: JSON.stringify(states) })
      .onDuplicateKeyUpdate({ set: { svalue: JSON.stringify(states) } });
  }

  private async stateFor(id: number): Promise<NewsScheduleState> {
    const states = await this.readStates();
    return { ...EMPTY_STATE, ...(states[id] ?? {}) };
  }

  // ---------------------------------------------------------------- 对外接口

  async listSchedules(): Promise<{ schedules: NewsSchedule[]; states: Record<number, NewsScheduleState> }> {
    const schedules = await this.readSchedules();
    const states = await this.readStates();
    const stateMap: Record<number, NewsScheduleState> = {};
    for (const s of schedules) stateMap[s.id] = { ...EMPTY_STATE, ...(states[s.id] ?? {}) };
    return { schedules, states: stateMap };
  }

  async saveSchedule(patch: Partial<NewsSchedule> & { id?: number }): Promise<{ schedule: NewsSchedule; state: NewsScheduleState }> {
    const list = await this.readSchedules();
    const isNew = !patch.id || !list.some((s) => s.id === patch.id);
    let next: NewsSchedule;
    if (isNew) {
      next = { ...DEFAULT_NEWS_SCHEDULE, ...patch, id: patch.id || Date.now() };
      next.name = next.name || '新任务计划';
      list.push(next);
    } else {
      const idx = list.findIndex((s) => s.id === patch.id);
      next = { ...list[idx], ...patch };
      list[idx] = next;
    }
    next.batchSize = Math.min(Math.max(Number(next.batchSize) || 10, 1), 200);
    await this.saveSchedules(list);
    const state = await this.refreshNext(next);
    return { schedule: next, state };
  }

  async deleteSchedule(id: number): Promise<{ ok: boolean }> {
    const list = await this.readSchedules();
    const idx = list.findIndex((s) => s.id === id);
    if (idx >= 0) {
      list.splice(idx, 1);
      await this.saveSchedules(list);
      const states = await this.readStates();
      delete states[id];
      await this.saveStates(states);
    }
    return { ok: true };
  }

  /** 解析目标语料域：计划配了就用它；否则用源绑定的语料域；再不行取第一个语料域。 */
  private async resolveDatasetId(schedule: NewsSchedule, src: NewsSource | null): Promise<number> {
    if (schedule.datasetId) return schedule.datasetId;
    if (src?.datasetId) return src.datasetId;
    const [ds] = await this.db
      .select({ id: datasets.id })
      .from(datasets)
      .orderBy(asc(datasets.sort), desc(datasets.id))
      .limit(1);
    return ds?.id ?? 0;
  }

  private async refreshNext(schedule: NewsSchedule, base = new Date()): Promise<NewsScheduleState> {
    const cur = await this.stateFor(schedule.id);
    const next = schedule.enabled ? this.computeNextAt(schedule, base) : null;
    const saved = await this.saveStateFor(schedule.id, { ...cur, nextRunAt: next ? next.toISOString() : null });
    return saved;
  }

  private async saveStateFor(id: number, state: NewsScheduleState): Promise<NewsScheduleState> {
    const states = await this.readStates();
    states[id] = state;
    await this.saveStates(states);
    return state;
  }

  /** 依据配置算下一次触发时刻（本地时区语义） */
  computeNextAt(s: NewsSchedule, from = new Date()): Date | null {
    if (!s.enabled) return null;
    if (s.mode === 'interval') {
      const mins = Math.max(Number(s.intervalMinutes) || 60, 5);
      return new Date(from.getTime() + mins * 60_000);
    }
    const [hh, mm] = (s.time || '03:00').split(':').map((n) => Number(n) || 0);
    const mk = (d: Date) => {
      const x = new Date(d);
      x.setHours(hh, mm, 0, 0);
      return x;
    };
    if (s.mode === 'daily') {
      const t = mk(from);
      if (t.getTime() > from.getTime()) return t;
      return mk(new Date(from.getTime() + 86_400_000));
    }
    if (s.mode === 'weekly') {
      const target = Math.min(Math.max(Number(s.weekday) || 1, 1), 7);
      for (let i = 0; i < 8; i += 1) {
        const d = mk(new Date(from.getTime() + i * 86_400_000));
        if (d.getTime() <= from.getTime()) continue;
        const jsDay = d.getDay();
        if ((jsDay === 0 ? 7 : jsDay) === target) return d;
      }
      return null;
    }
    const day = Math.min(Math.max(Number(s.day) || 1, 1), 28);
    for (let i = 0; i < 32; i += 1) {
      const d = mk(new Date(from.getTime() + i * 86_400_000));
      if (d.getTime() <= from.getTime()) continue;
      if (d.getDate() === day) return d;
    }
    return null;
  }

  // ---------------------------------------------------------------- 执行历史（system_setting 存 JSON）

  private async readRuns(): Promise<NewsRunRecord[]> {
    const [row] = await this.db.select().from(systemSettings).where(eq(systemSettings.skey, NEWS_RUNS_KEY)).limit(1);
    if (!row) return [];
    try {
      const arr = JSON.parse(row.svalue) as NewsRunRecord[];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  private async saveRuns(all: NewsRunRecord[]): Promise<void> {
    await this.db
      .insert(systemSettings)
      .values({ skey: NEWS_RUNS_KEY, svalue: JSON.stringify(all) })
      .onDuplicateKeyUpdate({ set: { svalue: JSON.stringify(all) } });
  }

  private async appendRun(rec: NewsRunRecord): Promise<void> {
    const all = [rec, ...(await this.readRuns())].slice(0, MAX_HISTORY);
    await this.db
      .insert(systemSettings)
      .values({ skey: NEWS_RUNS_KEY, svalue: JSON.stringify(all) })
      .onDuplicateKeyUpdate({ set: { svalue: JSON.stringify(all) } });
  }

  private async updateRun(id: number, patch: Partial<NewsRunRecord>): Promise<void> {
    const all = await this.readRuns();
    const idx = all.findIndex((r) => r.id === id);
    if (idx < 0) return;
    all[idx] = { ...all[idx], ...patch };
    await this.db
      .insert(systemSettings)
      .values({ skey: NEWS_RUNS_KEY, svalue: JSON.stringify(all) })
      .onDuplicateKeyUpdate({ set: { svalue: JSON.stringify(all) } });
  }

  async history(page = 1, pageSize = 20): Promise<{ total: number; items: NewsRunRecord[] }> {
    const all = await this.readRuns();
    const size = Math.min(Math.max(pageSize, 1), MAX_HISTORY);
    const offset = Math.max(0, (page - 1) * size);
    return { total: all.length, items: all.slice(offset, offset + size) };
  }

  // ---------------------------------------------------------------- 调度

  private async tick(): Promise<void> {
    try {
      const schedules = await this.readSchedules();
      if (!schedules.length) return;
      for (const s of schedules) {
        if (!s.enabled) continue;
        const state = await this.stateFor(s.id);
        if (state.running) continue;
        const now = Date.now();
        const next = state.nextRunAt ? new Date(state.nextRunAt).getTime() : null;
        if (next == null) {
          await this.refreshNext(s);
          continue;
        }
        if (now < next) continue;
        await this.runOnce('schedule', s.id);
      }
    } catch (err) {
      this.logger.error(`[news-schedule] tick 异常：${(err as Error).message}`);
    }
  }

  /** 立即执行一个计划（新闻入库 + 跑生产线） */
  async runOnce(source: 'schedule' | 'manual', scheduleId?: number) {
    const schedules = await this.readSchedules();
    // manual 未指定时执行第一个启用计划
    const s = scheduleId ? schedules.find((x) => x.id === scheduleId) : schedules.find((x) => x.enabled) ?? schedules[0];
    if (!s) return { ok: false, error: '没有可执行的任务计划' };
    const state0 = await this.stateFor(s.id);
    if (state0.running) return { ok: false, error: '该计划上一轮仍在执行中' };

    const allSources = await loadSources(this.db);
    const src = allSources.find((x) => x.id === s.sourceId) ?? null;
    if (!src) return { ok: false, error: `计划「${s.name}」绑定的新闻源不存在` };

    const datasetId = s.datasetId || src.datasetId;
    if (!datasetId) return { ok: false, error: '未绑定目标语料域（请选择语料域）' };

    await this.saveStateFor(s.id, { ...state0, running: true, lastStatus: 'running', lastError: null });
    const started = new Date();
    const mode: NewsRunRecord['mode'] = s.autoRun ? 'ingest+run' : 'ingest';

    const record: NewsRunRecord = {
      id: started.getTime(),
      source,
      datasetId,
      mode,
      startedAt: started.toISOString(),
      finishedAt: null,
      sampled: 0,
      created: 0,
      skipped: 0,
      queueTotal: 0,
      done: 0,
      failed: 0,
      entitiesCreated: 0,
      factDrafts: 0,
      tokens: 0,
      status: 'running',
      error: null,
    };
    await this.appendRun(record);

    try {
      // extractRelations 用「!== false」兜底：老计划（改动前存库、JSON 无此字段）视为开启
      const { ingest, run } = await this.news.ingestAndRun(
        src.id,
        s.batchSize,
        s.autoRun,
        s.datasetId || undefined,
        s.extractRelations !== false,
      );
      const finish = new Date();
      await this.updateRun(record.id, {
        sampled: ingest.sampled,
        created: ingest.created,
        skipped: ingest.skipped,
        queueTotal: run?.total ?? 0,
        done: run?.done ?? 0,
        failed: run?.failed ?? 0,
        entitiesCreated: run?.entitiesCreated ?? 0,
        factDrafts: run?.factDrafts ?? 0,
        tokens: run?.tokens ?? 0,
        status: 'success',
        error: null,
        finishedAt: finish.toISOString(),
      });
      const st = await this.refreshNext(s, finish);
      await this.saveStateFor(s.id, { ...st, running: false, lastRunAt: started.toISOString(), lastStatus: 'success', lastError: null });
      return { ok: true, record };
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`[news-schedule] 计划「${s.name}」执行失败(${source})：${message}`);
      await this.updateRun(record.id, { status: 'error', error: message, finishedAt: new Date().toISOString() });
      await this.saveStateFor(s.id, {
        ...(await this.stateFor(s.id)),
        running: false,
        lastRunAt: started.toISOString(),
        lastStatus: 'error',
        lastError: message,
      });
      return { ok: false, error: message };
    }
  }
}