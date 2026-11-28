import { afterEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseConfig } from '../src/config/load.js';
import { Controller } from '../src/controller/controller.js';
import { MemoryStore } from '../src/controller/store.js';
import type { FlagOps, LiveState } from '../src/flagsmith/ops.js';
import { createServer, hostName, type ServerOptions } from '../src/server.js';

const YAML = `
version: 1
flagsmith: { project: demo-shop, environment: Production }
metrics: { error_rate: { source: prometheus, query: "x" } }
flags:
  new_checkout:
    rollout: { steps: [5, 100], interval: 20s }
    guards: [{ metric: error_rate, max: 0.02 }]
`;

class FakeOps implements FlagOps {
  calls: string[] = [];
  live: LiveState = { exists: true, defaultEnabled: false, overridePresent: true, overrideEnabled: true, percent: 5 };
  async ensure() { return []; }
  async start(_f: string, p: number) { this.calls.push(`start ${p}`); }
  async setPercent() { /* unused */ }
  async rollback() { this.calls.push('rollback'); }
  async state() { return this.live; }
}

let server: Server | undefined;
afterEach(() => { server?.close(); server = undefined; });

async function boot(opts: Partial<ServerOptions> = {}) {
  const ops = new FakeOps();
  const store = new MemoryStore();
  const controller = new Controller({ config: parseConfig(YAML), ops, store, metrics: { read: async () => 0 } });
  server = createServer({ controller, store, environment: 'Production', ...opts }).listen(0, '127.0.0.1');
  await new Promise((r) => server!.once('listening', r));
  const port = (server.address() as AddressInfo).port;
  /** node:http (not fetch) so tests can set Host and Origin freely. */
  const call = (method: string, path: string, headers: Record<string, string> = {}, body?: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method, path, headers: { Host: `localhost:${port}`, ...headers } }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      });
      req.on('error', reject);
      req.end(body);
    });
  return { ops, controller, call, port };
}

describe('/metrics', () => {
  it('reports the rollout percent, but not while exposure was set by hand', async () => {
    const { call, controller } = await boot();
    await controller.start('new_checkout');
    expect((await call('GET', '/metrics')).body).toContain('guardian_rollout_percent{flag="new_checkout"} 5');
    await controller.onManualChange('new_checkout', 'turned ON');
    const body = (await call('GET', '/metrics')).body;
    expect(body).not.toContain('guardian_rollout_percent{flag=');
    expect(body).toContain('guardian_flag_status{flag="new_checkout"} 6');
  });
});

describe('control API without a token (local demo)', () => {
  it('accepts the CLI (no Origin) on localhost', async () => {
    const { call, ops } = await boot();
    expect((await call('POST', '/api/flags/new_checkout/rollback')).status).toBe(200);
    expect(ops.calls).toEqual(['rollback']);
  });

  it('accepts the bundled UI (same origin)', async () => {
    const { call, port } = await boot();
    expect((await call('POST', '/api/flags/new_checkout/rollback', { Origin: `http://localhost:${port}` })).status).toBe(200);
  });

  it('refuses cross-site requests (CSRF)', async () => {
    const { call, ops } = await boot();
    expect((await call('POST', '/api/flags/new_checkout/rollback', { Origin: 'https://evil.example' })).status).toBe(403);
    expect(ops.calls).toEqual([]);
  });

  it('refuses requests not addressed to localhost (LAN, DNS rebinding)', async () => {
    const { call, port } = await boot();
    expect((await call('POST', '/api/flags/new_checkout/rollback', { Host: `evil.example:${port}`, Origin: `http://evil.example:${port}` })).status).toBe(403);
    expect((await call('POST', '/api/flags/new_checkout/rollback', { Host: `192.168.1.5:${port}` })).status).toBe(403);
  });

  it('returns 404 for prototype keys instead of touching state', async () => {
    const { call } = await boot();
    expect((await call('POST', '/api/flags/__proto__/rollback')).status).toBe(404);
    expect(({} as Record<string, unknown>).status).toBeUndefined();
  });
});

describe('control API with GUARDIAN_API_TOKEN', () => {
  it('requires the bearer token, from any host', async () => {
    const { call, ops } = await boot({ apiToken: 't0ken' });
    expect((await call('POST', '/api/flags/new_checkout/rollback')).status).toBe(401);
    expect((await call('POST', '/api/flags/new_checkout/rollback', { Authorization: 'Bearer nope' })).status).toBe(401);
    expect((await call('POST', '/api/flags/new_checkout/rollback', { Authorization: 'Bearer t0ken', Host: 'guardian.internal' })).status).toBe(200);
    expect(ops.calls).toEqual(['rollback']);
  });

  it('keeps read-only endpoints open', async () => {
    const { call } = await boot({ apiToken: 't0ken' });
    expect((await call('GET', '/api/state')).status).toBe(200);
  });
});

describe('webhook receiver', () => {
  const payload = JSON.stringify({
    event_type: 'FLAG_UPDATED',
    data: { changed_by: 'alice', new_state: { enabled: true, feature: { name: 'new_checkout' }, environment: { name: 'Production' } } },
  });

  it('without a secret, refuses browser (Origin) posts but accepts Flagsmith', async () => {
    const { call, controller } = await boot();
    expect((await call('POST', '/webhooks/flagsmith', { 'Content-Type': 'text/plain', Origin: 'https://evil.example' }, payload)).status).toBe(403);
    expect(controller.flags.new_checkout.status).toBe('idle');
    const ok = await call('POST', '/webhooks/flagsmith', { 'Content-Type': 'application/json' }, payload);
    expect(JSON.parse(ok.body)).toEqual({ watching: true });
  });

  it('without a secret, refuses posts that came through the public tunnel gateway', async () => {
    const { call, controller } = await boot();
    const res = await call('POST', '/webhooks/flagsmith', { 'Content-Type': 'application/json', 'X-Guardian-Public-Gateway': '1' }, payload);
    expect(res.status).toBe(403);
    expect(controller.flags.new_checkout.status).toBe('idle');
  });

  it('with a secret, accepts signed posts through the gateway', async () => {
    const { call } = await boot({ webhookSecret: 's3cret' });
    const sig = createHmac('sha256', 's3cret').update(payload).digest('hex');
    const ok = await call('POST', '/webhooks/flagsmith', { 'Content-Type': 'application/json', 'X-Guardian-Public-Gateway': '1', 'X-Flagsmith-Signature': sig }, payload);
    expect(JSON.parse(ok.body)).toEqual({ watching: true });
  });

  it('with a secret, requires a valid signature', async () => {
    const { call } = await boot({ webhookSecret: 's3cret' });
    expect((await call('POST', '/webhooks/flagsmith', { 'Content-Type': 'application/json' }, payload)).status).toBe(401);
    const sig = createHmac('sha256', 's3cret').update(payload).digest('hex');
    const ok = await call('POST', '/webhooks/flagsmith', { 'Content-Type': 'application/json', 'X-Flagsmith-Signature': sig }, payload);
    expect(JSON.parse(ok.body)).toEqual({ watching: true });
  });

  it('ignores a feature named __proto__', async () => {
    const { call } = await boot();
    const evil = payload.replace('"new_checkout"', '"__proto__"');
    expect(JSON.parse((await call('POST', '/webhooks/flagsmith', { 'Content-Type': 'application/json' }, evil)).body)).toEqual({ ignored: true });
  });
});

describe('misc', () => {
  it('parses Host headers', () => {
    expect(hostName('localhost:8787')).toBe('localhost');
    expect(hostName('[::1]:8787')).toBe('[::1]');
    expect(hostName('LOCALHOST')).toBe('localhost');
    expect(hostName(undefined)).toBe('');
  });

  it('refuses to be framed', async () => {
    const { port } = await boot();
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });
});
