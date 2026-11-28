import type { GuardianConfig } from '../config/schema.js';
import { FlagsmithClient, findSplit, type SegmentOverride } from './client.js';

/** What the controller needs from Flagsmith, per guarded flag. */
export interface FlagOps {
  /** Make sure the feature and its split segment exist. Returns a short report of what was created. */
  ensure(flag: string): Promise<string[]>;
  /** Turn the rollout on at `percent` (override enabled, default off). */
  start(flag: string, percent: number): Promise<void>;
  setPercent(flag: string, percent: number): Promise<void>;
  /** Flag off for everyone: remove Guardian's override and disable the default. */
  rollback(flag: string): Promise<void>;
  state(flag: string): Promise<LiveState>;
}

export interface LiveState {
  exists: boolean;
  defaultEnabled: boolean;
  overridePresent: boolean;
  overrideEnabled: boolean;
  percent: number | null;
}

interface Ids { projectId: number; envKey: string; featureId?: number; segmentId?: number }

const segmentName = (flag: string) => `guardian/${flag}`;

/** FlagOps backed by a real Flagsmith instance. */
export class FlagsmithOps implements FlagOps {
  private cache = new Map<string, Ids>();
  /** Timestamps of Guardian's own writes, used to ignore our own webhooks. */
  readonly ownWrites = new Map<string, number>();

  constructor(private client: FlagsmithClient, private cfg: GuardianConfig) {}

  /** Own-property lookup, so a name like "constructor" never resolves to an inherited value. */
  private plan(flag: string) {
    return Object.hasOwn(this.cfg.flags, flag) ? this.cfg.flags[flag] : undefined;
  }

  private envName(flag: string) {
    return this.plan(flag)?.environment ?? this.cfg.flagsmith.environment;
  }

  private async ids(flag: string, create = false): Promise<Ids> {
    const cached = this.cache.get(flag);
    if (cached?.featureId && cached.segmentId) return cached;

    const project = await this.client.findProject(this.cfg.flagsmith.project);
    if (!project) throw new Error(`Flagsmith project "${this.cfg.flagsmith.project}" not found`);
    const env = await this.client.findEnvironment(project.id, this.envName(flag));
    if (!env) throw new Error(`Environment "${this.envName(flag)}" not found in project "${project.name}"`);

    let feature = await this.client.findFeature(project.id, flag);
    if (!feature && create) feature = await this.client.createFeature(project.id, flag, this.plan(flag)?.description);
    let segment = await this.client.findSegment(project.id, segmentName(flag));
    if (!segment && create) {
      segment = await this.client.createSplitSegment(project.id, segmentName(flag), this.plan(flag)?.rollout.steps[0] ?? 1);
    }
    const ids: Ids = { projectId: project.id, envKey: env.api_key, featureId: feature?.id, segmentId: segment?.id };
    this.cache.set(flag, ids);
    return ids;
  }

  private async required(flag: string) {
    const ids = await this.ids(flag, true);
    if (!ids.featureId || !ids.segmentId) throw new Error(`could not set up feature/segment for ${flag}`);
    return ids as Required<Ids>;
  }

  private mark(flag: string) {
    this.ownWrites.set(flag, Date.now());
  }

  async ensure(flag: string): Promise<string[]> {
    const before = await this.ids(flag, false);
    const report: string[] = [];
    if (!before.featureId) report.push(`create feature "${flag}" (off)`);
    if (!before.segmentId) report.push(`create segment "${segmentName(flag)}" (% split)`);
    this.cache.delete(flag);
    await this.required(flag);
    return report;
  }

  async start(flag: string, percent: number) {
    const ids = await this.required(flag);
    await this.client.setSegmentSplit(ids.projectId, ids.segmentId, percent);
    const current = await this.client.getFlag(ids.envKey, ids.featureId);
    // PATCH replaces the override list, so keep everyone else's overrides.
    const others = current.segment_overrides.filter((o) => o.segment.id !== ids.segmentId);
    const priority = others.length ? Math.max(...others.map((o) => o.priority)) + 1 : 0;
    const ours: SegmentOverride = { segment: { id: ids.segmentId }, enabled: true, priority };
    this.mark(flag);
    await this.client.patchFlag(ids.envKey, ids.featureId, {
      environment_default: { enabled: false },
      segment_overrides: [...others, ours],
    });
  }

  async setPercent(flag: string, percent: number) {
    const ids = await this.required(flag);
    this.mark(flag);
    await this.client.setSegmentSplit(ids.projectId, ids.segmentId, percent);
  }

  async rollback(flag: string) {
    const ids = await this.required(flag);
    this.mark(flag);
    await this.client.deleteOverride(ids.envKey, ids.featureId, ids.segmentId);
    await this.client.patchFlag(ids.envKey, ids.featureId, { environment_default: { enabled: false } });
  }

  async state(flag: string): Promise<LiveState> {
    const ids = await this.ids(flag, false);
    if (!ids.featureId) return { exists: false, defaultEnabled: false, overridePresent: false, overrideEnabled: false, percent: null };
    const flagState = await this.client.getFlag(ids.envKey, ids.featureId);
    const ours = flagState.segment_overrides.find((o) => o.segment.id === ids.segmentId);
    let percent: number | null = null;
    if (ids.segmentId) {
      const seg = await this.client.getSegment(ids.projectId, ids.segmentId);
      const c = findSplit(seg.rules);
      percent = c ? Number(c.value) : null;
    }
    return {
      exists: true,
      defaultEnabled: flagState.environment_default.enabled,
      overridePresent: !!ours,
      overrideEnabled: !!ours?.enabled,
      percent,
    };
  }
}
