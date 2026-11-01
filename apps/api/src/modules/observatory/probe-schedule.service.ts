import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../../db/db.module';
import { systemSettings } from '../../db/schema';
import { ProbeService } from './probe.service';

export interface ProbeSchedule {
  enabled: boolean;
  /** daily=每天，weekly=每周，monthly=每月，interval=按间隔 */
  mode: 'daily' | 'weekly' | 'monthly' | 'interval';
  /** HH:mm（日/周/月模式生效） */
  time: string;
  /** 1=周一 … 7=周日（weekly 生效） */
  weekday: number;
  /** 每月几号（monthly 生效，超长月份按最后一天） */
  day: number;
  /** 间隔分钟（interval 生效） */
  intervalMinutes: number;
}

export interface ProbeScheduleState {
  lastRunAt: string | null;
  lastStatus: 'success' | 'running' | 'error' | null;
  lastError: string | null;
  nextRunAt: string | null;
  running: boolean;
}

const SCHEDULE_KEY = 'PROBE_SCHEDULE';
const STATE_KEY = 'PROBE_SCHEDULE_STATE';

export const DEFAULT_SCHEDULE: ProbeSchedule = {
  enabled: false,
  mode: 'daily',
  time: '03:00',
  weekday: 1,
  day: 1,
  intervalMinutes: 1440,
};

/**
 * 探针任务计划：按每天/每周/每月/固定间隔，把库里全部 active 问题跑一遍大模型提问。
 * 配置与状态都落在 system_setting，不新增表；进程内每 60s 检查一次到点则触发。
 */
@Injectable()
export class ProbeScheduleService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProbeScheduleService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly probe: ProbeService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), 60_000);
    void this.tick(); // 启动时立即校准一次 nextRunAt
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async getSchedule(): Promise<ProbeSchedule> {
    const [row] = await this.db.select().from(systemSettings).where(eq(systemSettings.skey, SCHEDULE_KEY)).limit(1);
    if (!row) return { ...DEFAULT_SCHEDULE };
    try {
      return { ...DEFAULT_SCHEDULE, ...(JSON.parse(row.svalue) as Partial<ProbeSchedule>) };
    } catch {
      return { ...DEFAULT_SCHEDULE };
    }
  }

  async saveSchedule(patch: Partial<ProbeSchedule>): Promise<{ schedule: ProbeSchedule; state: ProbeScheduleState }> {
    const next: ProbeSchedule = { ...(await this.getSchedule()), ...patch };
    await this.db
      .insert(systemSettings)
      .values({ skey: SCHEDULE_KEY, svalue: JSON.stringify(next) })
      .onDuplicateKeyUpdate({ set: { svalue: JSON.stringify(next) } });
    const state = await this.refreshNext(next);
    return { schedule: next, state };
  }

  async getState(): Promise<ProbeScheduleState> {
    const [row] = await this.db.select().from(systemSettings).where(eq(systemSettings.skey, STATE_KEY)).limit(1);
    const fallback: ProbeScheduleState = { lastRunAt: null, lastStatus: null, lastError: null, nextRunAt: null, running: false };
    if (!row) return fallback;
    try {
      return { ...fallback, ...(JSON.parse(row.svalue) as Partial<ProbeScheduleState>) };
    } catch {
      return fallback;
    }
  }

  private async saveState(state: ProbeScheduleState): Promise<ProbeScheduleState> {
    await this.db
      .insert(systemSettings)
      .values({ skey: STATE_KEY, svalue: JSON.stringify(state) })
      .onDuplicateKeyUpdate({ set: { svalue: JSON.stringify(state) } });
    return state;
  }

  /** 重算下次执行时间（保存配置或执行完成后调用） */
  private async refreshNext(schedule: ProbeSchedule, base = new Date()): Promise<ProbeScheduleState> {
    const cur = await this.getState();
    const next = schedule.enabled ? this.computeNextAt(schedule, base) : null;
    return this.saveState({ ...cur, nextRunAt: next ? next.toISOString() : null });
  }

  /** 依据配置算下一次触发时刻（本地时区语义，与页面展示一致） */
  computeNextAt(s: ProbeSchedule, from = new Date()): Date | null {
    if (!s.enabled) return null;
    if (s.mode === 'interval') {
      const mins = Math.max(Number(s.intervalMinutes) || 1440, 5);
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
      // 1=周一…7=周日
      const target = Math.min(Math.max(Number(s.weekday) || 1, 1), 7);
      for (let i = 0; i < 8; i += 1) {
        const d = mk(new Date(from.getTime() + i * 86_400_000));
        if (d.getTime() <= from.getTime()) continue;
        const jsDay = d.getDay(); // 0=周日
        if ((jsDay === 0 ? 7 : jsDay) === target) return d;
      }
      return null;
    }
    // monthly
    const day = Math.min(Math.max(Number(s.day) || 1, 1), 28);
    for (let i = 0; i < 32; i += 1) {
      const d = mk(new Date(from.getTime() + i * 86_400_000));
      if (d.getTime() <= from.getTime()) continue;
      if (d.getDate() === day) return d;
    }
    return null;
  }

  private async tick(): Promise<void> {
    try {
      const [schedule, state] = [await this.getSchedule(), await this.getState()];
      if (!schedule.enabled) return;
      if (state.running) return;
      const now = Date.now();
      const next = state.nextRunAt ? new Date(state.nextRunAt).getTime() : null;
      if (next == null) {
        await this.refreshNext(schedule);
        return;
      }
      if (now < next) return;
      await this.runOnce('schedule');
    } catch (err) {
      this.logger.error(`[probe-schedule] tick 异常：${(err as Error).message}`);
    }
  }

  /** 立即跑一轮（全量 active 问题） */
  async runOnce(source: 'schedule' | 'manual'): Promise<{ ok: boolean; runIds: number[]; questionCount: number; error?: string }> {
    const state0 = await this.getState();
    if (state0.running) return { ok: false, runIds: [], questionCount: 0, error: '上一轮任务仍在执行中' };
    await this.saveState({ ...state0, running: true, lastStatus: 'running', lastError: null });
    const started = new Date();
    try {
      const { runs, results } = await this.probe.runProbe();
      const finish = new Date();
      const schedule = await this.getSchedule();
      const state = await this.refreshNext(schedule, finish);
      await this.saveState({
        ...state,
        running: false,
        lastRunAt: started.toISOString(),
        lastStatus: 'success',
        lastError: null,
      });
      return { ok: true, runIds: runs.map((r) => r.runId), questionCount: new Set(results.map((r) => r.questionId)).size };
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`[probe-schedule] 执行失败(${source})：${message}`);
      await this.saveState({
        ...(await this.getState()),
        running: false,
        lastRunAt: started.toISOString(),
        lastStatus: 'error',
        lastError: message,
      });
      return { ok: false, runIds: [], questionCount: 0, error: message };
    }
  }
}
