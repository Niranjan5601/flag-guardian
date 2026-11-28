import { EventEmitter } from 'node:events';
import { DEFAULT_WATCH_MS, type FlagPlan, type GuardianConfig } from '../config/schema.js';
import type { FlagOps } from '../flagsmith/ops.js';
import type { MetricReader } from '../metrics/index.js';
import type { Store } from './store.js';
import { initialRuntime, type EventType, type FlagRuntime, type GuardianEvent } from './types.js';

export interface ControllerDeps {
  config: GuardianConfig;
  ops: FlagOps;
  metrics: MetricReader;
  store: Store;
  notify?: (e: GuardianEvent) => unknown;
  now?: () => number;
  /** consecutive failing ticks before acting on a breach (default 2) */
  breachTicks?: number;
  /** ignore webhooks for a flag this long after Guardian wrote to it (ms) */
  ownWriteGraceMs?: number;
  ownWrites?: Map<string, number>;
}

interface Evaluation {
  values: Record<string, number | null>;
  samples: number | null;
  breached: string[];
  missing: string[];
  /** fewer samples than min_samples: too little traffic to judge health either way */
  lowTraffic: boolean;
}

const ACTIVE: ReadonlySet<FlagRuntime['status']> = new Set(['rolling', 'holding', 'watching']);

const fmt = (v: number | null) => (v === null ? 'no data' : Math.abs(v) < 1 ? v.toFixed(4) : v.toFixed(1));

export class Controller extends EventEmitter {
  readonly flags: Record<string, FlagRuntime>;
  private now: () => number;
  private breachTicks: number;
  private locks = new Set<string>();
  /** Flags that were mid-rollout in saved state but are no longer in flags.yaml (nobody watches them now). */
  readonly orphaned: string[];

  constructor(private d: ControllerDeps) {
    super();
    this.now = d.now ?? Date.now;
    this.breachTicks = d.breachTicks ?? 2;
    const saved = d.store.load();
    this.flags = {};
    for (const name of Object.keys(d.config.flags)) {
      this.flags[name] = Object.hasOwn(saved, name) ? saved[name] : initialRuntime(this.now());
    }
    this.orphaned = Object.keys(saved).filter((n) => !this.has(n) && ACTIVE.has(saved[n].status));
  }

  /**
   * Own-property check. Flag names come from HTTP paths and webhook payloads, and a plain
   * `config.flags[name]` is truthy for "__proto__" / "constructor": a request could then write
   * rollout state onto Object.prototype (prototype pollution).
   */
  has(flag: string): boolean {
    return Object.hasOwn(this.d.config.flags, flag);
  }

  plan(flag: string): FlagPlan {
    if (!this.has(flag)) throw new Error(`unknown flag "${flag}" (not in flags.yaml)`);
    return this.d.config.flags[flag];
  }

  /** Flagsmith environment a flag is rolled out in (per-flag override, else the default). */
  environmentOf(flag: string): string {
    return this.plan(flag).environment ?? this.d.config.flagsmith.environment;
  }

  snapshot() {
    return Object.entries(this.flags).map(([name, runtime]) => ({ name, plan: this.d.config.flags[name], runtime }));
  }

  // --- actions

  async start(flag: string) {
    return this.locked(flag, async () => {
      const plan = this.plan(flag);
      const rt = this.flags[flag];
      if (rt.status === 'rolling' || rt.status === 'holding') throw new Error(`${flag} is already rolling out`);
      await this.d.ops.ensure(flag);
      await this.goToStep(flag, 0, 'started', `Rollout started at ${plan.rollout.steps[0]}%`);
    });
  }

  async resume(flag: string) {
    return this.locked(flag, async () => {
      const rt = this.flags[flag];
      if (rt.status === 'rolling' || rt.status === 'holding') throw new Error(`${flag} is already rolling out`);
      const steps = this.plan(flag).rollout.steps;
      const back = rt.status === 'rolled_back' || rt.status === 'held' ? rt.stepIndex - 1 : 0;
      // Clamp: flags.yaml may have fewer steps now than when the saved stepIndex was recorded.
      const from = Math.min(Math.max(0, back), steps.length - 1);
      const pct = steps[from];
      await this.d.ops.ensure(flag);
      await this.goToStep(flag, from, 'resumed', `Rollout resumed at ${pct}% (last healthy step)`);
    });
  }

  async rollback(flag: string, reason = 'Manual rollback') {
    return this.locked(flag, async () => {
      this.plan(flag);
      await this.turnOff(flag, reason, `${reason}. Flag is off for everyone.`);
    });
  }

  /** Webhook receiver hook for a hand-made change. Changes in other environments are ignored. */
  async onManualChange(flag: string, detail: string, environment?: string) {
    if (!this.has(flag)) return false;
    if (environment && environment !== this.environmentOf(flag)) return false;
    const own = this.d.ownWrites?.get(flag);
    if (own && this.now() - own < (this.d.ownWriteGraceMs ?? 10_000)) return false;
    // Locked so a webhook arriving mid-tick cannot be overwritten by the tick's own state writes.
    return this.locked(flag, async () => {
      this.startWatch(flag, detail);
      return true;
    });
  }

  // --- tick loop

  async tick() {
    for (const flag of Object.keys(this.flags)) {
      if (this.locks.has(flag)) continue;
      try {
        await this.locked(flag, () => this.tickFlag(flag));
      } catch (e) {
        const msg = (e as Error).message;
        if (this.flags[flag].reason !== msg) {
          this.set(flag, { reason: msg });
          this.event(flag, 'error', `Error: ${msg}`);
        }
      }
    }
  }

  private async tickFlag(flag: string) {
    const plan = this.plan(flag);
    const rt = this.flags[flag];
    const ev = await this.evaluate(plan);
    this.set(flag, { values: ev.values, samples: ev.samples });

    if (rt.status === 'rolled_back' && rt.rollbackPending) {
      // A previous rollback failed half-way. ops.rollback is idempotent, so just try again;
      // a failure here throws and tick() reports it (once per distinct message).
      await this.d.ops.rollback(flag);
      this.set(flag, { percent: 0, rollbackPending: undefined, reason: 'Rollback finished after retry' });
      this.event(flag, 'rolled_back', 'Rollback finished after retry. Flag is off for everyone.', ev.values);
      return;
    }

    if (rt.status === 'rolling' || rt.status === 'holding') {
      const live = await this.d.ops.state(flag);
      if (!live.overridePresent || !live.overrideEnabled || live.defaultEnabled) {
        this.startWatch(flag, 'Flag changed outside Guardian during rollout; automation stopped', 'idle');
        return;
      }
      if (await this.handleBreach(flag, plan, ev)) return;

      if (ev.missing.length || ev.lowTraffic) {
        const reason = ev.missing.length
          ? `Holding: no data for ${ev.missing.join(', ')}`
          // floor, not round: increase() is fractional, and 14.6 must not read "15 samples < 15".
          : `Holding: ${Math.floor(ev.samples ?? 0)} samples < ${plan.rollout.min_samples}`;
        if (rt.status !== 'holding') this.event(flag, 'holding', reason, ev.values);
        this.set(flag, { status: 'holding', reason });
        return;
      }
      // The interval means "healthy for this long". Time spent holding (no data / too little
      // traffic) was not observed healthy, so the step's clock restarts when data comes back.
      this.set(flag, rt.status === 'holding'
        ? { status: 'rolling', reason: undefined, stepStartedAt: this.now() }
        : { status: 'rolling', reason: undefined });

      if (this.now() - rt.stepStartedAt >= plan.rollout.interval) {
        const last = plan.rollout.steps.length - 1;
        if (rt.stepIndex >= last) {
          this.set(flag, { status: 'complete' });
          this.event(flag, 'completed', `Rollout complete at ${rt.percent}%. All guards healthy.`, ev.values);
        } else {
          const next = rt.stepIndex + 1;
          await this.d.ops.setPercent(flag, plan.rollout.steps[next]);
          this.set(flag, { stepIndex: next, percent: plan.rollout.steps[next], stepStartedAt: this.now() });
          this.event(flag, 'step_advanced', `Advanced to ${plan.rollout.steps[next]}% after ${plan.rollout.interval / 1000}s healthy`, ev.values);
        }
      }
      return;
    }

    if (rt.status === 'watching') {
      if (await this.handleBreach(flag, plan, ev)) return;
      if (rt.watchUntil && this.now() >= rt.watchUntil) {
        this.set(flag, { status: rt.afterWatch ?? 'idle', watchUntil: undefined, afterWatch: undefined, reason: undefined });
        this.event(flag, 'watch_ended', `Watch window ended; no regressions.`, ev.values);
      }
    }
  }

  /** Returns true when the breach was acted on (or is being confirmed). */
  private async handleBreach(flag: string, plan: FlagPlan, ev: Evaluation): Promise<boolean> {
    const rt = this.flags[flag];
    // Too little traffic: don't judge (2 errors in 3 requests is not a 66% error rate).
    // The streak is left as is; it neither grows nor resets on an unjudgeable tick.
    if (ev.lowTraffic) return false;
    if (!ev.breached.length) {
      if (rt.breachStreak) this.set(flag, { breachStreak: 0 });
      return false;
    }
    const streak = rt.breachStreak + 1;
    const what = ev.breached.join('; ');
    if (streak < this.breachTicks) {
      this.set(flag, { breachStreak: streak });
      this.event(flag, 'breach_detected', `Guard failing: ${what} (confirming…)`, ev.values);
      return true;
    }
    if (plan.on_breach === 'rollback') {
      await this.turnOff(flag, what, `Rolled back automatically: ${what}. Flag is off for everyone.`, ev.values);
    } else {
      this.set(flag, { status: 'held', breachStreak: 0, reason: what });
      this.event(flag, 'held', `Rollout held at ${rt.percent}%: ${what}`, ev.values);
    }
    return true;
  }

  private async evaluate(plan: FlagPlan): Promise<Evaluation> {
    const values: Record<string, number | null> = {};
    const breached: string[] = [];
    const missing: string[] = [];
    for (const g of plan.guards) {
      // Own-property check: `"constructor" in {}` is true and would yield a function, not a value.
      const v = Object.hasOwn(values, g.metric) ? values[g.metric] : await this.d.metrics.read(g.metric);
      values[g.metric] = v;
      if (v === null) { missing.push(g.metric); continue; }
      if (g.max !== undefined && v > g.max) breached.push(`${g.metric} = ${fmt(v)} > ${g.max}`);
      if (g.min !== undefined && v < g.min) breached.push(`${g.metric} = ${fmt(v)} < ${g.min}`);
    }
    const samples = plan.rollout.samples ? await this.d.metrics.read(plan.rollout.samples) : null;
    if (plan.rollout.samples && samples === null) missing.push(plan.rollout.samples);
    const lowTraffic = plan.rollout.min_samples > 0 && (samples ?? 0) < plan.rollout.min_samples;
    return { values, samples, breached, missing: [...new Set(missing)], lowTraffic };
  }

  // --- helpers

  private async goToStep(flag: string, index: number, type: EventType, message: string) {
    const pct = this.plan(flag).rollout.steps[index];
    await this.d.ops.start(flag, pct);
    this.set(flag, {
      status: 'rolling', stepIndex: index, percent: pct, stepStartedAt: this.now(),
      breachStreak: 0, reason: undefined, watchUntil: undefined, afterWatch: undefined, rollbackPending: undefined,
      manualExposure: undefined,
    });
    this.event(flag, type, message);
  }

  /**
   * Turn the flag off for everyone (manual and automatic rollback). ops.rollback is two
   * Flagsmith calls (DELETE override, PATCH default off). If it fails, possibly half-way, the
   * flag is still marked rolled_back with `rollbackPending` and the next tick retries.
   * Otherwise it would stay "rolling" and the drift check would report our own missing
   * override as a human change.
   */
  private async turnOff(flag: string, reason: string, message: string, values?: Record<string, number | null>) {
    try {
      await this.d.ops.rollback(flag);
    } catch (e) {
      const msg = (e as Error).message;
      // percent is left as is: the cohort may still have the flag until the retry succeeds.
      // reason = the raw error so tick()'s duplicate-error check stays quiet on identical retries.
      this.set(flag, { status: 'rolled_back', breachStreak: 0, rollbackPending: true, reason: msg });
      this.event(flag, 'error', `Rollback (${reason}) incomplete, retrying every tick: ${msg}`, values);
      throw e;
    }
    this.set(flag, { status: 'rolled_back', percent: 0, breachStreak: 0, rollbackPending: undefined, manualExposure: undefined, reason });
    this.event(flag, 'rolled_back', message, values);
  }

  private startWatch(flag: string, detail: string, afterWatch?: FlagRuntime['status']) {
    const rt = this.flags[flag];
    const ms = this.plan(flag).watch_manual_changes ?? DEFAULT_WATCH_MS;
    const back = afterWatch ?? (rt.status === 'watching' ? rt.afterWatch : rt.status === 'rolling' || rt.status === 'holding' ? 'idle' : rt.status);
    this.set(flag, { status: 'watching', watchUntil: this.now() + ms, afterWatch: back, breachStreak: 0, reason: detail, manualExposure: true });
    this.event(flag, 'manual_change_detected', `${detail}. Watching guards for ${Math.round(ms / 1000)}s.`);
  }

  private async locked<T>(flag: string, fn: () => Promise<T>): Promise<T> {
    while (this.locks.has(flag)) await new Promise((r) => setTimeout(r, 25));
    this.locks.add(flag);
    try { return await fn(); } finally { this.locks.delete(flag); }
  }

  private set(flag: string, patch: Partial<FlagRuntime>) {
    Object.assign(this.flags[flag], patch, { updatedAt: this.now() });
    this.d.store.save(this.flags);
    this.emit('state', flag, this.flags[flag]);
  }

  private event(flag: string, type: EventType, message: string, values?: Record<string, number | null>) {
    const e: GuardianEvent = { ts: this.now(), flag, type, message, percent: this.flags[flag].percent, values };
    this.d.store.append(e);
    this.emit('event', e);
    try { void Promise.resolve(this.d.notify?.(e)).catch(() => {}); } catch { /* never let notifications break the loop */ }
  }
}
