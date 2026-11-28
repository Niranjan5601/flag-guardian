#!/usr/bin/env node
import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { countRiskier, diffConfigs, plain, renderMarkdown, renderText, type ReviewInput } from './config/diff.js';
import { loadConfig, validateConfigText } from './config/load.js';
import { Controller } from './controller/controller.js';
import { FileStore } from './controller/store.js';
import type { FlagRuntime } from './controller/types.js';
import { FlagsmithClient } from './flagsmith/client.js';
import { FlagsmithOps } from './flagsmith/ops.js';
import { Metrics } from './metrics/index.js';
import { createNotifier } from './notify/index.js';
import { isLoopbackListen, parsePort, parseTickSeconds } from './options.js';
import { createServer } from './server.js';

// .env for local runs, from cwd or the repo root. Real env vars win.
for (const f of [process.env.GUARDIAN_ENV_FILE, '.env', '../../.env'].filter(Boolean) as string[]) {
  if (existsSync(f)) { process.loadEnvFile(f); break; }
}

const env = (k: string, fallback?: string) => process.env[k] || fallback;
const configPath = () => resolve(program.opts().config ?? env('GUARDIAN_CONFIG') ?? (existsSync('flags.yaml') ? 'flags.yaml' : '../../flags.yaml'));
const guardianUrl = () => env('GUARDIAN_URL', 'http://localhost:8787')!;

function flagsmith() {
  const key = env('FLAGSMITH_API_KEY');
  if (!key) throw new Error('FLAGSMITH_API_KEY is not set (organisation API key)');
  return new FlagsmithClient(env('FLAGSMITH_API_URL', 'http://localhost:8000/api/v1/')!, key);
}

function die(e: unknown): never {
  console.error(`✖ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

const program = new Command()
  .name('guardian')
  .description('Health-gated rollouts and automatic rollback for self-hosted Flagsmith')
  .option('-c, --config <path>', 'path to flags.yaml');

program
  .command('validate')
  .description('check flags.yaml (schema, metric references, expired flags)')
  .option('--strict', 'treat warnings as errors')
  .action((o) => {
    const path = configPath();
    const r = validateConfigText(readText(path), { strict: o.strict });
    for (const w of r.warnings) console.log(`⚠ ${plain(w)}`);
    for (const e of r.errors) console.log(`✖ ${plain(e)}`);
    if (!r.ok) process.exit(1);
    const n = Object.keys(r.config!.flags).length;
    console.log(`✔ ${path}: ${n} guarded flag${n === 1 ? '' : 's'} OK`);
  });

/** Reads a file (or stdin for "-"); a missing file is a clear error, not a stack trace. */
function readText(path: string): string {
  try {
    return readFileSync(path === '-' ? 0 : path, 'utf8');
  } catch (e) {
    return die(`cannot read ${path === '-' ? 'stdin' : path}: ${(e as Error).message}`);
  }
}

program
  .command('diff')
  .description('offline review of a flags.yaml change (used by the GitHub Action; never contacts Flagsmith)')
  .option('--base <path>', 'the previous flags.yaml, or "-" for stdin (omit when there is none: every flag is new)')
  .option('--format <format>', 'text | markdown', 'text')
  .option('--strict', 'treat warnings as errors')
  .option('--fail-on-riskier', 'exit 2 when a change exposes more users sooner or weakens a guard')
  .action((o) => {
    if (o.format !== 'text' && o.format !== 'markdown') die(`--format must be text or markdown, got "${o.format}"`);
    const file = configPath();
    // env {}: ${VAR} references expand to "" (as if unset), so secrets never reach CI output or PR comments.
    const head = validateConfigText(readText(file), { strict: o.strict, env: {} });
    // A --base that cannot be read is an error, not "no base": silently treating every flag as
    // new would hide riskier changes and let --fail-on-riskier pass.
    let base: ReviewInput['base'] = null;
    if (o.base !== undefined) base = validateConfigText(readText(o.base), { env: {} }).config ?? 'invalid';
    const input: ReviewInput = { file: program.opts().config ?? 'flags.yaml', head, base };
    console.log(o.format === 'markdown' ? renderMarkdown(input) : renderText(input));
    // exitCode, not exit(): lets stdout drain when it is a pipe (asynchronous on macOS).
    if (!head.ok) process.exitCode = 1;
    else if (o.failOnRiskier && countRiskier(diffConfigs(base === 'invalid' ? null : base, head.config!)) > 0) process.exitCode = 2;
  });

program
  .command('plan')
  .description('show what flags.yaml would change in Flagsmith')
  .action(async () => {
    try {
      const cfg = loadConfig(configPath());
      const ops = new FlagsmithOps(flagsmith(), cfg);
      console.log(`Project "${cfg.flagsmith.project}", environment "${cfg.flagsmith.environment}"\n`);
      for (const [name, plan] of Object.entries(cfg.flags)) {
        const live = await ops.state(name);
        const guards = plan.guards.map((g) => `${g.metric}${g.max !== undefined ? `<${g.max}` : ''}${g.min !== undefined ? `>${g.min}` : ''}`).join(', ');
        const mark = live.exists ? '~' : '+';
        console.log(`${mark} ${name}: rollout ${plan.rollout.steps.join('→')}% every ${plan.rollout.interval / 1000}s, guards ${guards}, on breach ${plan.on_breach}`);
        if (!live.exists) console.log(`    + feature and segment will be created (off)`);
        else console.log(`    live: default ${live.defaultEnabled ? 'ON' : 'off'}, guardian override ${live.overridePresent ? (live.overrideEnabled ? 'ON' : 'off') : 'none'}, split ${live.percent ?? '–'}%`);
      }
    } catch (e) { die(e); }
  });

program
  .command('apply')
  .description('create missing features and split segments in Flagsmith')
  .action(async () => {
    try {
      const cfg = loadConfig(configPath());
      const ops = new FlagsmithOps(flagsmith(), cfg);
      for (const name of Object.keys(cfg.flags)) {
        const done = await ops.ensure(name);
        console.log(done.length ? done.map((d) => `+ ${d}`).join('\n') : `= ${name}: up to date`);
      }
    } catch (e) { die(e); }
  });

program
  .command('run')
  .description('run the controller, webhook receiver and UI')
  .option('-p, --port <port>', 'HTTP port', env('PORT', '8787'))
  // Loopback by default: the no-token mode's Host check only stops browsers, so the socket
  // itself must not be reachable from other machines unless the operator opts in.
  .option('--host <address>', 'interface to listen on (0.0.0.0 = all; set GUARDIAN_API_TOKEN then)', env('GUARDIAN_HOST', '127.0.0.1'))
  .option('--tick <seconds>', 'seconds between health checks (>= 1)', env('GUARDIAN_TICK_SECONDS', '10'))
  .action(async (o) => {
    try {
      // Validate options before touching Flagsmith, so a typo fails fast and changes nothing.
      const port = parsePort(o.port);
      const host: string = o.host;
      const tickSeconds = parseTickSeconds(o.tick);
      const cfg = loadConfig(configPath());
      const ops = new FlagsmithOps(flagsmith(), cfg);
      const store = new FileStore(env('GUARDIAN_DATA_DIR', './data')!);
      const controller = new Controller({
        config: cfg,
        ops,
        ownWrites: ops.ownWrites,
        metrics: new Metrics(cfg.metrics, env('PROMETHEUS_URL', 'http://localhost:9090')!),
        store,
        notify: createNotifier({
          discord: cfg.notify.discord,
          slack: cfg.notify.slack,
          grafanaUrl: env('GRAFANA_URL', 'http://localhost:3000'),
          grafanaToken: env('GRAFANA_TOKEN'),
          linkUrl: env('GUARDIAN_PUBLIC_URL', `http://localhost:${port}`),
        }),
      });
      controller.on('event', (e) => console.log(`[${new Date(e.ts).toLocaleTimeString()}] ${e.flag}: ${e.message}`));
      for (const name of controller.orphaned) {
        console.warn(`⚠ "${name}" was mid-rollout but is no longer in flags.yaml; Guardian no longer watches it. Check it in Flagsmith.`);
      }

      for (const name of Object.keys(cfg.flags)) {
        const done = await ops.ensure(name);
        for (const d of done) console.log(`+ ${d}`);
      }

      const secret = env('FLAGSMITH_WEBHOOK_SECRET');
      if (!secret) console.warn('⚠ FLAGSMITH_WEBHOOK_SECRET not set: webhook signatures are NOT verified');
      const apiToken = env('GUARDIAN_API_TOKEN');
      if (!apiToken && isLoopbackListen(host)) {
        console.warn('⚠ GUARDIAN_API_TOKEN not set: start/resume/rollback accept any local client (browsers only from this page)');
      } else if (!apiToken) {
        console.warn(`⚠ GUARDIAN_API_TOKEN not set while listening on ${host}: ANY client that can reach this port can start/resume/rollback flags. Set GUARDIAN_API_TOKEN.`);
      }
      createServer({ controller, store, environment: cfg.flagsmith.environment, webhookSecret: secret, apiToken })
        .listen(port, host, () => console.log(`Flag Guardian on http://localhost:${port}  (listening on ${host}, ${Object.keys(cfg.flags).length} guarded flags, tick ${tickSeconds}s)`))
        .on('error', (e: NodeJS.ErrnoException) => die(e.code === 'EADDRINUSE' ? `port ${port} is already in use; pass --port or set PORT` : e));

      const tickMs = tickSeconds * 1000;
      const loop = async () => {
        // tick() reports Flagsmith errors as events itself; this catches the rest (e.g. the
        // data dir is not writable) so one bad tick never stops the loop for good.
        try { await controller.tick(); } catch (e) { console.error(`✖ tick failed: ${(e as Error).message}`); }
        setTimeout(loop, tickMs);
      };
      setTimeout(loop, 1000);
    } catch (e) { die(e); }
  });

interface RemoteFlag { name: string; runtime: FlagRuntime }

async function remote<T>(path: string, method = 'GET'): Promise<T> {
  const token = env('GUARDIAN_API_TOKEN');
  const res = await fetch(guardianUrl() + path, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(30_000),
  }).catch(() => die(`Guardian is not reachable at ${guardianUrl()} (is "guardian run" running?)`));
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!body) die(`${guardianUrl()} answered ${res.status} but it is not Guardian (wrong GUARDIAN_URL or port?)`);
  if (!res.ok) die(body.error ?? `HTTP ${res.status}`);
  return body;
}

program
  .command('status')
  .description('show every guarded flag')
  .action(async () => {
    const s = await remote<{ flags: RemoteFlag[] }>('/api/state');
    for (const f of s.flags) {
      const v = Object.entries(f.runtime.values ?? {}).map(([k, n]) => `${k}=${n ?? '–'}`).join(' ');
      console.log(`${f.name.padEnd(24)} ${f.runtime.status.padEnd(12)} ${String(f.runtime.percent).padStart(3)}%  ${v}${f.runtime.reason ? `  (${f.runtime.reason})` : ''}`);
    }
  });

for (const action of ['start', 'rollback', 'resume'] as const) {
  program
    .command(`${action} <flag>`)
    .description(`${action} a guarded rollout`)
    .action(async (flag) => {
      const r = await remote<{ runtime: FlagRuntime }>(`/api/flags/${encodeURIComponent(flag)}/${action}`, 'POST');
      console.log(`✔ ${flag}: ${r.runtime.status} at ${r.runtime.percent}%`);
    });
}

program.parseAsync().catch(die);
