// Demo shop for Flag Guardian.
//
// The checkout has two versions behind the Flagsmith flag `new_checkout`:
//   off → classic checkout (stable)
//   on  → new one-page checkout (can have a planted bug, see BUGGY_CHECKOUT)
//
// Every request is counted in Prometheus with a `flag_new_checkout` label, so
// Flag Guardian can watch the health of exactly the users who got the new version.

import express from 'express';
import { Flagsmith } from '@flagsmith/nodejs';
import client from 'prom-client';

const PORT = Number(process.env.PORT ?? 3001);
const FLAG = 'new_checkout';
// The /admin/bug switch is a demo feature: off unless DEMO_ADMIN=true (docker-compose turns it
// on and publishes the port on 127.0.0.1 only). Never enable it on a reachable host.
const ADMIN_ENABLED = process.env.DEMO_ADMIN === 'true';
const MAX_USER_LENGTH = 128;
const state = {
  // The planted bug. Switch at runtime: POST /admin/bug?on=true|false (needs DEMO_ADMIN=true)
  buggy: process.env.BUGGY_CHECKOUT === 'true',
  errorRate: Number(process.env.BUG_ERROR_RATE ?? 0.15),
  extraLatencyMs: Number(process.env.BUG_LATENCY_MS ?? 600),
};

if (!process.env.FLAGSMITH_ENVIRONMENT_KEY) {
  console.error('FLAGSMITH_ENVIRONMENT_KEY is not set (server-side SDK key of the environment)');
  process.exit(1);
}

// Local evaluation: the SDK downloads the environment and evaluates flags in-process.
// A short refresh interval means a rollback reaches the app within a few seconds.
const flagsmith = new Flagsmith({
  environmentKey: process.env.FLAGSMITH_ENVIRONMENT_KEY,
  apiUrl: process.env.FLAGSMITH_API_URL ?? 'http://localhost:8000/api/v1/',
  enableLocalEvaluation: process.env.FLAGSMITH_LOCAL_EVALUATION !== 'false',
  environmentRefreshIntervalSeconds: Number(process.env.FLAGSMITH_REFRESH_SECONDS ?? 3),
  defaultFlagHandler: () => ({ enabled: false, value: null, isDefault: true }),
});

// --- metrics
const registry = new client.Registry();
registry.setDefaultLabels({ app: 'demo-shop' });
client.collectDefaultMetrics({ register: registry });

const requests = new client.Counter({
  name: 'http_requests_total',
  help: 'Checkout requests by flag variant and status',
  labelNames: ['route', 'status', 'flag_new_checkout'],
  registers: [registry],
});
const duration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Checkout latency by flag variant',
  labelNames: ['route', 'flag_new_checkout'],
  buckets: [0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 0.8, 1, 1.5, 2, 3],
  registers: [registry],
});
// Pre-create series so Prometheus has zeros instead of "no data" before traffic arrives.
for (const v of ['on', 'off']) {
  requests.labels('/api/checkout', '200', v).inc(0);
  requests.labels('/api/checkout', '500', v).inc(0);
}

// --- app
const app = express();
app.disable('x-powered-by');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (base) => base * (0.6 + Math.random() * 0.8);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const userId = (raw, fallback) => String(raw ?? fallback).slice(0, MAX_USER_LENGTH);

async function isNewCheckout(user) {
  try {
    const flags = await flagsmith.getIdentityFlags(user);
    return flags.isFeatureEnabled(FLAG);
  } catch (e) {
    console.warn(`flag evaluation failed, using classic checkout: ${e.message}`);
    return false;
  }
}

async function checkout(user) {
  const isNew = await isNewCheckout(user);
  if (isNew) {
    await sleep(jitter(70) + (state.buggy ? jitter(state.extraLatencyMs) : 0));
    if (state.buggy && Math.random() < state.errorRate) {
      return { isNew, status: 500, body: { ok: false, error: 'PaymentIntent is undefined', checkout: 'one-page' } };
    }
    return { isNew, status: 200, body: { ok: true, checkout: 'one-page', steps: 1 } };
  }
  await sleep(jitter(110));
  return { isNew, status: 200, body: { ok: true, checkout: 'classic', steps: 3 } };
}

app.post('/api/checkout', async (req, res) => {
  const user = userId(req.query.user ?? req.header('x-user-id'), 'anonymous');
  const end = duration.startTimer();
  const r = await checkout(user);
  const variant = r.isNew ? 'on' : 'off';
  end({ route: '/api/checkout', flag_new_checkout: variant });
  requests.inc({ route: '/api/checkout', status: String(r.status), flag_new_checkout: variant });
  res.status(r.status).json({ user, ...r.body });
});

// Small storefront page, handy for the demo video: /?user=alice
app.get('/', async (req, res) => {
  const user = userId(req.query.user, `visitor-${Math.floor(Math.random() * 1000)}`);
  const isNew = await isNewCheckout(user);
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Demo Shop</title><style>
body{font:16px system-ui,sans-serif;max-width:520px;margin:40px auto;padding:0 16px;background:#f7f7fb;color:#1d1d2b}
.card{background:#fff;border-radius:14px;padding:24px;box-shadow:0 2px 12px #0001}
.tag{display:inline-block;padding:3px 10px;border-radius:99px;font-size:13px;background:${isNew ? '#dcfce7;color:#166534' : '#e5e7eb;color:#374151'}}
button{width:100%;padding:14px;border:0;border-radius:10px;background:#4f46e5;color:#fff;font-size:16px;cursor:pointer;margin-top:16px}
#out{margin-top:12px;font-family:ui-monospace,monospace;font-size:13px}</style></head><body>
<div class="card"><p>Signed in as <b>${escapeHtml(user)}</b></p>
<span class="tag">${isNew ? 'NEW one-page checkout' : 'Classic 3-step checkout'}</span>
<h2>Mechanical keyboard · $129</h2>
<button id="pay" data-user="${escapeHtml(user)}">${isNew ? 'Pay now' : 'Continue to shipping →'}</button>
<div id="out"></div></div>
<script>
// The user id travels in a data attribute, never inside inline JS (it comes from the query string).
const pay = document.getElementById('pay'), out = document.getElementById('out');
pay.addEventListener('click', () => fetch('/api/checkout?user=' + encodeURIComponent(pay.dataset.user), { method: 'POST' })
  .then((r) => r.json()).then((j) => { out.textContent = JSON.stringify(j); }));
</script></body></html>`);
});

app.get('/metrics', async (_req, res) => {
  res.type(registry.contentType).send(await registry.metrics());
});

app.get('/healthz', (_req, res) => res.json({ ok: true, buggy: state.buggy }));

// Demo control: turn the planted bug on/off without restarting. Opt-in (DEMO_ADMIN=true).
app.post('/admin/bug', (req, res) => {
  if (!ADMIN_ENABLED) return res.status(404).json({ error: 'demo admin is disabled (set DEMO_ADMIN=true)' });
  // Browsers send Origin on cross-site POSTs; refuse them so another web page cannot flip the bug.
  // curl / Invoke-RestMethod send no Origin.
  const origin = req.header('origin');
  if (origin !== undefined && origin !== `http://${req.header('host')}`) return res.status(403).json({ error: 'cross-origin request refused' });
  if (req.query.error_rate !== undefined) {
    const rate = Number(req.query.error_rate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) return res.status(400).json({ error: 'error_rate must be between 0 and 1' });
    state.errorRate = rate;
  }
  if (req.query.on !== undefined) state.buggy = req.query.on === 'true';
  console.log(`planted bug ${state.buggy ? 'ON' : 'off'} (error rate ${state.errorRate})`);
  res.json(state);
});

app.listen(PORT, () => {
  console.log(`demo-shop on http://localhost:${PORT}  (bug ${state.buggy ? 'ON' : 'off'}, /admin/bug ${ADMIN_ENABLED ? 'enabled' : 'disabled'})`);
});

const shutdown = async () => { await flagsmith.close?.(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
