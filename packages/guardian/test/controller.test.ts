import { describe, expect, it, vi } from 'vitest';
import { parseConfig, validateConfigText } from '../src/config/load.js';
import { Controller } from '../src/controller/controller.js';
import { FileStore, MemoryStore } from '../src/controller/store.js';
import { initialRuntime } from '../src/controller/types.js';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FlagOps, LiveState } from '../src/flagsmith/ops.js';
import { createHmac } from 'node:crypto';
import { verifySignature, parseFlagUpdated } from '../src/flagsmith/webhooks.js';

const YAML = `
version: 1
flagsmith: { project: demo-shop, environment: production }
metrics:
  error_rate: { source: prometheus, query: "x" }
  requests: { source: prometheus, query: "y" }
flags:
  new_checkout:
    rollout: { steps: [5, 25, 50, 100], interval: 20s, samples: requests, min_samples: 10 }
    guards: [{ metric: error_rate, max: 0.02 }]
    on_breach: rollback
    watch_manual_changes: 1m
`;

class FakeOps implements FlagOps {
  live: LiveState = { exists: true, defaultEnabled: false, overridePresent: false, overrideEnabled: false, percent: null };
  calls: string[] = [];
  async ensure() { this.calls.push('ensure'); return []; }
  async start(_f: string, p: number) { this.calls.push(`start ${p}`); this.live = { ...this.live, overridePresent: true, overrideEnabled: true, percent: p }; }
  async setPercent(_f: string, p: number) { this.calls.push(`pct ${p}`); this.live.percent = p; }
  async rollback() { this.calls.push('rollback'); this.live = { ...this.live, overridePresent: false, overrideEnabled: false, defaultEnabled: false }; }
  async state() { return this.live; }
}

function setup(values: Record<string, number | null> = { error_rate: 0.001, requests: 100 }) {
  let t = 1_000_000;
  const ops = new FakeOps();
  const metrics = { values, read: async (n: string) => metrics.values[n] ?? null };
  const store = new MemoryStore();
  const ctl = new Controller({ config: parseConfig(YAML), ops, metrics, store, now: () => t });
  return { ctl, ops, metrics, store, advance: (ms: number) => { t += ms; } };
}

describe('controller', () => {
  it('walks through every step while healthy, then completes', async () => {
    const { ctl, ops, advance } = setup();
    await ctl.start('new_checkout');
    for (let i = 0; i < 4; i++) { advance(21_000); await ctl.tick(); }
    expect(ops.calls).toEqual(['ensure', 'start 5', 'pct 25', 'pct 50', 'pct 100']);
    expect(ctl.flags.new_checkout.status).toBe('complete');
  });

  it('does not advance before the interval has passed', async () => {
    const { ctl, ops, advance } = setup();
    await ctl.start('new_checkout');
    advance(5_000); await ctl.tick();
    expect(ops.calls).not.toContain('pct 25');
    expect(ctl.flags.new_checkout.percent).toBe(5);
  });

  it('rolls back after two consecutive failing ticks', async () => {
    const { ctl, ops, metrics, store, advance } = setup();
    await ctl.start('new_checkout');
    advance(21_000); await ctl.tick(); // → 25%
    metrics.values.error_rate = 0.09;
    advance(10_000); await ctl.tick();
    expect(ctl.flags.new_checkout.status).toBe('rolling'); // confirming
    advance(10_000); await ctl.tick();
    expect(ctl.flags.new_checkout.status).toBe('rolled_back');
    expect(ops.calls.at(-1)).toBe('rollback');
    expect(store.events.map((e) => e.type)).toContain('rolled_back');
  });

  it('a single noisy tick does not roll back', async () => {
    const { ctl, metrics, advance } = setup();
    await ctl.start('new_checkout');
    metrics.values.error_rate = 0.5;
    advance(10_000); await ctl.tick();
    metrics.values.error_rate = 0.001;
    advance(10_000); await ctl.tick();
    expect(ctl.flags.new_checkout.status).toBe('rolling');
    expect(ctl.flags.new_checkout.breachStreak).toBe(0);
  });

  it('holds (never advances or rolls back) when metrics are missing', async () => {
    const { ctl, ops, metrics, advance } = setup();
    await ctl.start('new_checkout');
    metrics.values.error_rate = null;
    advance(60_000); await ctl.tick(); await ctl.tick(); await ctl.tick();
    expect(ctl.flags.new_checkout.status).toBe('holding');
    expect(ops.calls).not.toContain('rollback');
    expect(ops.calls).not.toContain('pct 25');
  });

  it('holds when there are too few samples', async () => {
    const { ctl, metrics, advance } = setup();
    await ctl.start('new_checkout');
    metrics.values.requests = 3;
    advance(30_000); await ctl.tick();
    expect(ctl.flags.new_checkout.status).toBe('holding');
    expect(ctl.flags.new_checkout.percent).toBe(5);
  });

  it('never reports a fractional sample count as reaching min_samples', async () => {
    const { ctl, metrics, advance } = setup();
    await ctl.start('new_checkout');
    metrics.values.requests = 9.6; // increase() is fractional; rounding would say "10 samples < 10"
    advance(30_000); await ctl.tick();
    expect(ctl.flags.new_checkout.reason).toBe('Holding: 9 samples < 10');
  });

  it('stops automating when someone changes the flag by hand mid-rollout', async () => {
    const { ctl, ops, advance } = setup();
    await ctl.start('new_checkout');
    ops.live.defaultEnabled = true; // human turned it on for everyone
    advance(21_000); await ctl.tick();
    expect(ctl.flags.new_checkout.status).toBe('watching');
    expect(ops.calls).not.toContain('pct 25');
  });

  it('marks exposure as manual after a hand-made change, until Guardian takes over again', async () => {
    const { ctl, ops, advance } = setup();
    await ctl.start('new_checkout');
    ops.live.defaultEnabled = true;
    advance(5_000); await ctl.tick();
    expect(ctl.flags.new_checkout.manualExposure).toBe(true);
    advance(61_000); await ctl.tick(); // watch window over
    expect(ctl.flags.new_checkout).toMatchObject({ status: 'idle', manualExposure: true });
    await ctl.start('new_checkout');
    expect(ctl.flags.new_checkout.manualExposure).toBeUndefined();
    await ctl.onManualChange('new_checkout', 'turned ON'); // webhook: manual again
    await ctl.rollback('new_checkout');
    expect(ctl.flags.new_checkout).toMatchObject({ status: 'rolled_back', percent: 0 });
    expect(ctl.flags.new_checkout.manualExposure).toBeUndefined();
  });

  it('watches a manual change and rolls back on regression', async () => {
    const { ctl, ops, metrics, advance } = setup();
    expect(await ctl.onManualChange('new_checkout', 'turned ON by alice')).toBe(true);
    metrics.values.error_rate = 0.2;
    advance(10_000); await ctl.tick();
    advance(10_000); await ctl.tick();
    expect(ctl.flags.new_checkout.status).toBe('rolled_back');
    expect(ops.calls).toContain('rollback');
  });

  it('watch window ends quietly when healthy', async () => {
    const { ctl, advance } = setup();
    await ctl.onManualChange('new_checkout', 'turned ON');
    advance(61_000); await ctl.tick();
    expect(ctl.flags.new_checkout.status).toBe('idle');
  });

  it('ignores webhooks caused by its own writes', async () => {
    const { ops, metrics } = setup();
    const ownWrites = new Map([['new_checkout', 1_000_000]]);
    const ctl = new Controller({ config: parseConfig(YAML), ops, metrics, store: new MemoryStore(), now: () => 1_002_000, ownWrites });
    expect(await ctl.onManualChange('new_checkout', 'x')).toBe(false);
  });

  it('resume restarts from the last healthy step', async () => {
    const { ctl, ops, metrics, advance } = setup();
    await ctl.start('new_checkout');
    advance(21_000); await ctl.tick(); // 25%
    metrics.values.error_rate = 1;
    await ctl.tick(); await ctl.tick();
    metrics.values.error_rate = 0;
    await ctl.resume('new_checkout');
    expect(ops.calls.at(-1)).toBe('start 5');
  });

  it('refuses prototype keys as flag names (no prototype pollution)', async () => {
    const { ctl, ops } = setup();
    for (const name of ['__proto__', 'constructor', 'toString']) {
      await expect(ctl.rollback(name)).rejects.toThrow(/unknown flag/);
      await expect(ctl.start(name)).rejects.toThrow(/unknown flag/);
      expect(await ctl.onManualChange(name, 'x')).toBe(false);
    }
    expect(ops.calls).toEqual([]);
    expect(({} as Record<string, unknown>).status).toBeUndefined();
  });

  it('does not judge a breach on too little traffic', async () => {
    const { ctl, ops, metrics, advance } = setup();
    await ctl.start('new_checkout');
    metrics.values = { error_rate: 0.66, requests: 3 }; // 2 errors in 3 requests
    for (let i = 0; i < 3; i++) { advance(10_000); await ctl.tick(); }
    expect(ops.calls).not.toContain('rollback');
    expect(ctl.flags.new_checkout.status).toBe('holding');
  });

  it('treats a missing samples metric as no data', async () => {
    const { ctl, metrics, advance } = setup();
    await ctl.start('new_checkout');
    metrics.values.requests = null;
    advance(30_000); await ctl.tick();
    expect(ctl.flags.new_checkout.status).toBe('holding');
    expect(ctl.flags.new_checkout.reason).toMatch(/no data for requests/);
  });

  it('restarts the step clock after holding (interval = time observed healthy)', async () => {
    const { ctl, ops, metrics, advance } = setup();
    await ctl.start('new_checkout');
    metrics.values.error_rate = null;
    advance(60_000); await ctl.tick(); // holding, interval long passed
    metrics.values.error_rate = 0.001;
    advance(5_000); await ctl.tick(); // data back: rolling again, clock restarted
    expect(ops.calls).not.toContain('pct 25');
    advance(21_000); await ctl.tick();
    expect(ops.calls).toContain('pct 25');
  });

  it('ignores webhooks for another environment', async () => {
    const { ctl } = setup();
    expect(await ctl.onManualChange('new_checkout', 'x', 'Staging')).toBe(false);
    expect(await ctl.onManualChange('new_checkout', 'x', 'production')).toBe(true);
  });

  it('a webhook during a tick is not overwritten by that tick', async () => {
    const { ctl, ops, advance } = setup();
    await ctl.start('new_checkout');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const realState = ops.state.bind(ops);
    ops.state = async () => { await gate; return realState(); };
    advance(5_000);
    const tick = ctl.tick();
    const hook = ctl.onManualChange('new_checkout', 'turned ON by alice');
    release();
    await tick; await hook;
    expect(ctl.flags.new_checkout.status).toBe('watching');
  });

  it('resume clamps to the steps that exist now', async () => {
    const { ops, metrics } = setup();
    const store = new MemoryStore();
    store.flags.new_checkout = { ...initialRuntime(0), status: 'rolled_back', stepIndex: 9 };
    const ctl = new Controller({ config: parseConfig(YAML), ops, metrics, store, now: () => 0 });
    await ctl.resume('new_checkout');
    expect(ops.calls.at(-1)).toBe('start 100');
  });

  it('a half-finished rollback stays rolled_back and is retried, not reported as a human change', async () => {
    const { ctl, ops, metrics, store, advance } = setup();
    await ctl.start('new_checkout');
    // Flagsmith: the override DELETE succeeds, then the default PATCH fails (once).
    let fail = true;
    ops.rollback = async () => {
      ops.calls.push('rollback');
      ops.live = { ...ops.live, overridePresent: false, overrideEnabled: false };
      if (fail) { fail = false; throw new Error('Flagsmith PATCH → 502'); }
    };
    metrics.values.error_rate = 0.5;
    advance(10_000); await ctl.tick(); // confirming
    advance(10_000); await ctl.tick(); // rollback attempt fails half-way
    expect(ctl.flags.new_checkout).toMatchObject({ status: 'rolled_back', rollbackPending: true });
    expect(store.events.filter((e) => e.type === 'error')).toHaveLength(1);
    advance(10_000); await ctl.tick(); // retry succeeds
    expect(ctl.flags.new_checkout).toMatchObject({ status: 'rolled_back', percent: 0, rollbackPending: undefined });
    const types = store.events.map((e) => e.type);
    expect(types).not.toContain('manual_change_detected');
    expect(types.at(-1)).toBe('rolled_back');
    expect(ops.calls.filter((c) => c === 'rollback')).toHaveLength(2);
  });

  it('a failed manual rollback is reported to the caller and retried by the tick', async () => {
    const { ctl, ops, advance } = setup();
    await ctl.start('new_checkout');
    const real = ops.rollback.bind(ops);
    ops.rollback = async () => { ops.rollback = real; throw new Error('timeout'); };
    await expect(ctl.rollback('new_checkout')).rejects.toThrow('timeout');
    expect(ctl.flags.new_checkout.rollbackPending).toBe(true);
    advance(10_000); await ctl.tick();
    expect(ctl.flags.new_checkout).toMatchObject({ status: 'rolled_back', percent: 0 });
    expect(ctl.flags.new_checkout.rollbackPending).toBeUndefined();
  });

  it('reports flags that were mid-rollout but left flags.yaml', () => {
    const { ops, metrics } = setup();
    const store = new MemoryStore();
    store.flags.old_flag = { ...initialRuntime(0), status: 'rolling' };
    store.flags.done_flag = { ...initialRuntime(0), status: 'complete' };
    const ctl = new Controller({ config: parseConfig(YAML), ops, metrics, store, now: () => 0 });
    expect(ctl.orphaned).toEqual(['old_flag']);
  });
});

describe('config', () => {
  it('rejects unknown metric references and non-increasing steps', () => {
    const bad = YAML.replace('metric: error_rate', 'metric: nope').replace('[5, 25, 50, 100]', '[5, 5]');
    const r = validateConfigText(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/unknown metric "nope"/);
    expect(r.errors.join('\n')).toMatch(/strictly increase/);
  });

  it('warns on expired flags, errors with --strict', () => {
    const y = YAML.replace('on_breach: rollback', 'on_breach: rollback\n    expires: 2020-01-01');
    expect(validateConfigText(y).warnings[0]).toMatch(/expired/);
    expect(validateConfigText(y, { strict: true }).ok).toBe(false);
  });

  it('rejects min_samples without a samples metric (would hold forever)', () => {
    const r = validateConfigText(YAML.replace('samples: requests, ', ''));
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/min_samples needs rollout.samples/);
  });

  it('rejects inherited names as metric references (a guard on "constructor" would never fail)', () => {
    for (const name of ['constructor', 'toString', '__proto__']) {
      const r = validateConfigText(YAML.replace('metric: error_rate', `metric: ${name}`));
      expect(r.ok, name).toBe(false);
      expect(r.errors.join('\n')).toMatch(new RegExp(`unknown metric "${name}"`));
      const s = validateConfigText(YAML.replace('samples: requests', `samples: ${name}`));
      expect(s.ok, name).toBe(false);
    }
  });

  it('rejects reserved and non-identifier flag and metric names', () => {
    for (const name of ['constructor', 'toString', 'has space', 'a/b', '..', '-x']) {
      const flag = validateConfigText(YAML.replace('  new_checkout:', `  "${name}":`));
      expect(flag.ok, `flag ${name}`).toBe(false);
      const metric = validateConfigText(YAML.replace('  requests:', `  "${name}":`).replace('samples: requests', `samples: "${name}"`));
      expect(metric.ok, `metric ${name}`).toBe(false);
    }
    // A YAML "__proto__" key must not become a flag either (rejected, or dropped by the parser).
    const proto = validateConfigText(YAML.replace('  new_checkout:', '  __proto__:'));
    expect(proto.ok && Object.hasOwn(proto.config!.flags, '__proto__')).toBe(false);
    expect(({} as Record<string, unknown>).rollout).toBeUndefined();
    expect(validateConfigText(YAML.replace('  new_checkout:', '  checkout.v2-beta_1:')).ok).toBe(true);
  });

  it('parses durations', () => {
    expect(parseConfig(YAML).flags.new_checkout.rollout.interval).toBe(20_000);
  });
});

describe('webhooks', () => {
  it('verifies the HMAC signature', () => {
    const body = Buffer.from('{"event_type":"FLAG_UPDATED"}');
    const sig = createHmac('sha256', 's3cret').update(body).digest('hex');
    expect(verifySignature(body, sig, 's3cret')).toBe(true);
    expect(verifySignature(body, sig, 'wrong')).toBe(false);
    expect(verifySignature(body, undefined, 's3cret')).toBe(false);
  });

  it('parses FLAG_UPDATED payloads', () => {
    const p = parseFlagUpdated({
      event_type: 'FLAG_UPDATED',
      data: { changed_by: 'alice@example.com', new_state: { enabled: true, feature: { name: 'new_checkout' }, environment: { name: 'Production' }, feature_segment: null } },
    });
    expect(p).toMatchObject({ feature: 'new_checkout', environment: 'Production', changedBy: 'alice@example.com', enabled: true, isSegmentOverride: false });
  });

  it('ignores non-string fields in untrusted payloads', () => {
    expect(parseFlagUpdated({ event_type: 'FLAG_UPDATED', data: { new_state: { feature: { name: { x: 1 } } } } })).toBeNull();
    expect(parseFlagUpdated(null)).toBeNull();
  });
});

describe('store', () => {
  it('skips a truncated last line in events.jsonl instead of failing to start', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guardian-'));
    writeFileSync(join(dir, 'events.jsonl'), JSON.stringify({ ts: 1, flag: 'f', type: 'started', message: 'm' }) + '\n{"ts":2,"fl');
    expect(new FileStore(dir).recent()).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('moves a corrupt state.json aside and starts fresh instead of failing to start', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guardian-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const bad of ['{"new_checkout": {"status": "roll', '[]', 'null']) {
        writeFileSync(join(dir, 'state.json'), bad);
        expect(new FileStore(dir).load()).toEqual({});
        expect(existsSync(join(dir, 'state.json'))).toBe(false);
      }
      expect(readdirSync(dir).filter((f) => f.startsWith('state.json.corrupt-')).length).toBeGreaterThan(0);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
