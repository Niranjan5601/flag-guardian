import { describe, expect, it } from 'vitest';
import { FlagsmithClient, splitRules, type Segment } from '../src/flagsmith/client.js';

/** Fake fetch that serves one segment and records every request. */
function fakeFlagsmith(segment: Segment) {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? 'GET', url: String(url), body });
    return new Response(JSON.stringify(init?.method === 'PUT' ? body : segment), { status: 200 });
  };
  return { calls, client: new FlagsmithClient('http://fs/api/v1/', 'key', fetchImpl as typeof fetch) };
}

describe('FlagsmithClient.setSegmentSplit', () => {
  it('keeps the segment description in the PUT (a full update would clear it)', async () => {
    const { client, calls } = fakeFlagsmith({
      id: 7, name: 'guardian/new_checkout', project: 1, description: 'Managed by Flag Guardian. Do not edit by hand.', rules: splitRules(5),
    });
    await client.setSegmentSplit(1, 7, 25);
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.body).toMatchObject({ name: 'guardian/new_checkout', description: 'Managed by Flag Guardian. Do not edit by hand.' });
    expect(JSON.stringify(put?.body)).toContain('"value":"25"');
  });

  it('does not send a null description', async () => {
    const { client, calls } = fakeFlagsmith({ id: 7, name: 'guardian/x', project: 1, description: null, rules: splitRules(5) });
    await client.setSegmentSplit(1, 7, 50);
    expect(calls.find((c) => c.method === 'PUT')?.body).not.toHaveProperty('description');
  });
});
