import express, { type NextFunction, type Request, type Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Controller } from './controller/controller.js';
import type { FlagStatus, GuardianEvent } from './controller/types.js';
import type { Store } from './controller/store.js';
import { parseFlagUpdated, verifySignature } from './flagsmith/webhooks.js';

export interface ServerOptions {
  controller: Controller;
  store: Store;
  environment: string;
  webhookSecret?: string;
  /**
   * Bearer token for the control API (start / resume / rollback). When unset, browsers are
   * limited to Guardian's own page on localhost, and every other client that can reach the
   * socket is trusted (see `guardControl`).
   */
  apiToken?: string;
  /** cap on concurrent SSE clients (each holds a socket and two listeners) */
  maxStreamClients?: number;
}

const STATUS_CODE: Record<FlagStatus, number> = {
  idle: 0, rolling: 1, holding: 2, complete: 3, rolled_back: 4, held: 5, watching: 6,
};

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Added (never passed through from the client) by the tunnel gateway in infra/gateway/nginx.conf. */
const PUBLIC_GATEWAY_HEADER = 'X-Guardian-Public-Gateway';

/** Hostname part of a Host header ("localhost:8787" → "localhost", "[::1]:8787" → "[::1]"). */
export function hostName(host: string | undefined): string {
  const m = /^(\[[^\]]*\]|[^:]*)(?::\d+)?$/.exec(host ?? '');
  return (m?.[1] ?? '').toLowerCase();
}

/** True when a browser Origin header names the same host:port the request was sent to. */
function sameOrigin(origin: string, host: string | undefined): boolean {
  try { return new URL(origin).host === host; } catch { return false; }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest();

/** Prometheus label values must escape backslash, double quote and newline. */
const label = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

/**
 * Who may call state-changing endpoints.
 *
 * With a token, `Authorization: Bearer <token>` is required. Browsers cannot send that header
 * cross-site without a CORS preflight, which Guardian never answers, so this also stops CSRF.
 *
 * Without a token (local demo) the checks only stop *browsers*: Host must be localhost (a
 * DNS-rebinding page sends its own domain) and any Origin must be Guardian's own (CSRF). curl
 * can set Host to anything, so other machines are kept out by the listen address instead:
 * 127.0.0.1 by default. In Docker Compose Guardian binds 0.0.0.0 inside the container, so other
 * containers on the compose network can call this API; set GUARDIAN_API_TOKEN beyond a laptop
 * demo. The CLI sends no Origin, so it still works against http://localhost:8787.
 */
function guardControl(apiToken: string | undefined) {
  const want = apiToken ? sha256(apiToken) : undefined;
  return (req: Request, res: Response, next: NextFunction) => {
    if (want) {
      const m = /^Bearer (.+)$/.exec(req.header('Authorization') ?? '');
      // Compare fixed-length digests so the check is constant-time regardless of input length.
      if (m && timingSafeEqual(sha256(m[1]), want)) { next(); return; }
      res.status(401).json({ ok: false, error: 'missing or wrong API token (GUARDIAN_API_TOKEN)' });
      return;
    }
    const origin = req.header('Origin');
    if (!LOOPBACK_HOSTS.has(hostName(req.header('Host')))) {
      res.status(403).json({ ok: false, error: 'without GUARDIAN_API_TOKEN the control API must be addressed to localhost' });
      return;
    }
    if (origin !== undefined && !sameOrigin(origin, req.header('Host'))) {
      res.status(403).json({ ok: false, error: 'cross-origin request refused' });
      return;
    }
    next();
  };
}

export function createServer({ controller, store, environment, webhookSecret, apiToken, maxStreamClients = 50 }: ServerOptions) {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    // The UI has buttons that change production flags: refuse to be framed (clickjacking).
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // Webhook: needs the raw body for the HMAC check, so register before express.json().
  app.post('/webhooks/flagsmith', express.raw({ type: '*/*', limit: '1mb' }), async (req: Request, res: Response) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    if (webhookSecret) {
      if (!verifySignature(raw, req.header('X-Flagsmith-Signature'), webhookSecret)) {
        res.status(401).json({ error: 'bad signature' });
        return;
      }
    } else if (req.header('Origin') !== undefined) {
      // Unsigned mode: Flagsmith never sends Origin, browsers always do on cross-site POSTs.
      // Without this any web page could post a fake FLAG_UPDATED and halt a running rollout.
      res.status(403).json({ error: 'unsigned webhooks are not accepted from browsers' });
      return;
    } else if (req.header(PUBLIC_GATEWAY_HEADER) !== undefined) {
      // Set by infra/gateway/nginx.conf: this request came through the public tunnel, where
      // anyone on the internet could post a fake FLAG_UPDATED. Unsigned mode is laptop-only.
      res.status(403).json({ error: 'unsigned webhooks are not accepted through the public gateway (set FLAGSMITH_WEBHOOK_SECRET)' });
      return;
    }
    let payload: unknown;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { res.status(400).json({ error: 'invalid json' }); return; }
    const upd = parseFlagUpdated(payload);
    if (!upd) {
      res.json({ ignored: true });
      return;
    }
    const who = upd.changedBy ? ` by ${upd.changedBy}` : '';
    const what = upd.isSegmentOverride ? 'segment override changed' : `turned ${upd.enabled ? 'ON' : 'OFF'}`;
    try {
      const watching = await controller.onManualChange(upd.feature, `Manual change: ${upd.feature} ${what}${who}`, upd.environment);
      res.json(watching ? { watching } : { ignored: true });
    } catch (e) {
      // Express 4 does not catch async errors; an unhandled rejection here would crash Guardian.
      console.error(`[webhook] ${(e as Error).message}`);
      res.status(500).json({ error: 'failed to process webhook' });
    }
  });

  app.use(express.json({ limit: '16kb' }));

  app.get('/healthz', (_req, res) => { res.json({ ok: true }); });

  // Read-only views are not authenticated: they show flags.yaml plans and metric values,
  // nothing secret. EventSource cannot send an Authorization header anyway.
  app.get('/api/state', (_req, res) => {
    res.json({ environment, flags: controller.snapshot(), events: store.recent(100) });
  });

  let streamClients = 0;
  // Each SSE client adds 2 listeners; raise Node's leak warning threshold to match the cap.
  controller.setMaxListeners(maxStreamClients * 2 + 10);
  app.get('/api/stream', (req, res) => {
    if (streamClients >= maxStreamClients) {
      res.status(503).json({ error: 'too many live connections' });
      return;
    }
    streamClients++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const send = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    const onEvent = (e: GuardianEvent) => send('guardian', e);
    const onState = () => send('state', controller.snapshot());
    controller.on('event', onEvent);
    controller.on('state', onState);
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    send('state', controller.snapshot());
    req.on('close', () => {
      streamClients--;
      clearInterval(ping);
      controller.off('event', onEvent);
      controller.off('state', onState);
    });
  });

  const control = guardControl(apiToken);
  for (const action of ['start', 'resume', 'rollback'] as const) {
    app.post(`/api/flags/:flag/${action}`, control, async (req, res) => {
      const flag = req.params.flag;
      if (!controller.has(flag)) {
        res.status(404).json({ ok: false, error: `unknown flag "${flag}" (not in flags.yaml)` });
        return;
      }
      try {
        await controller[action](flag);
        res.json({ ok: true, flag, runtime: controller.flags[flag] });
      } catch (e) {
        res.status(400).json({ ok: false, error: (e as Error).message });
      }
    });
  }

  // Guardian's own metrics, for the Grafana dashboard.
  app.get('/metrics', (_req, res) => {
    const flags = controller.snapshot();
    const lines = [
      '# HELP guardian_rollout_percent Current rollout percentage per guarded flag',
      '# TYPE guardian_rollout_percent gauge',
      // Left out while someone else controls exposure: Grafana shows a gap, not a stale number.
      ...flags.filter((f) => !f.runtime.manualExposure)
        .map((f) => `guardian_rollout_percent{flag="${label(f.name)}"} ${f.runtime.percent}`),
      '# HELP guardian_flag_status 0 idle,1 rolling,2 holding,3 complete,4 rolled_back,5 held,6 watching',
      '# TYPE guardian_flag_status gauge',
      ...flags.map((f) => `guardian_flag_status{flag="${label(f.name)}"} ${Object.hasOwn(STATUS_CODE, f.runtime.status) ? STATUS_CODE[f.runtime.status] : -1}`),
    ];
    res.type('text/plain; version=0.0.4').send(lines.join('\n') + '\n');
  });

  // Static UI, found from both src/ (tsx) and dist/ (built).
  const here = dirname(fileURLToPath(import.meta.url));
  const ui = [join(here, 'ui'), join(here, '..', 'src', 'ui')].find((p) => existsSync(join(p, 'index.html')));
  if (ui) app.use(express.static(ui));

  return app;
}
