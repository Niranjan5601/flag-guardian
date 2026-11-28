// Simulated shoppers for the demo: USERS distinct identities, about RPS checkouts per second.
// No dependencies; uses the built-in fetch.

const TARGET = (process.env.TARGET_URL ?? 'http://localhost:3001').replace(/\/+$/, '');
const USERS = Number(process.env.USERS ?? 200);
const RPS = Number(process.env.RPS ?? 20);

let ok = 0, failed = 0, newCheckout = 0, down = 0;

async function shop() {
  const user = `user-${Math.floor(Math.random() * USERS)}`;
  try {
    const res = await fetch(`${TARGET}/api/checkout?user=${user}`, { method: 'POST', signal: AbortSignal.timeout(5000) });
    const body = await res.json().catch(() => ({}));
    if (res.ok) ok++; else failed++;
    if (body.checkout === 'one-page') newCheckout++;
  } catch {
    down++;
  }
}

setInterval(() => {
  // Poisson-ish arrivals so the traffic looks natural on charts.
  const n = Math.max(0, Math.round(RPS / 10 + (Math.random() - 0.5) * (RPS / 10)));
  for (let i = 0; i < n; i++) void shop();
}, 100);

setInterval(() => {
  const total = ok + failed;
  const pct = total ? ((newCheckout / total) * 100).toFixed(0) : '0';
  console.log(`last 10s: ${total} checkouts, ${failed} errors, ${pct}% on new checkout${down ? `, ${down} unreachable` : ''}`);
  ok = failed = newCheckout = down = 0;
}, 10_000);

console.log(`loadgen → ${TARGET}  (${USERS} users, ~${RPS} req/s)`);
