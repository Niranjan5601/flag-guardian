import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GuardianEvent } from '../src/controller/types.js';
import { createNotifier } from '../src/notify/index.js';

const SECRET_URL = 'https://discord.com/api/webhooks/123/s3cret-token';
const event: GuardianEvent = { ts: 0, flag: 'new_checkout', type: 'rolled_back', message: 'rolled back', percent: 0 };

afterEach(() => { vi.restoreAllMocks(); });

const logged = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.map((c) => c.join(' ')).join('\n');

describe('notifier', () => {
  it('logs non-2xx answers with status and host only, never the secret URL', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response('Unknown Webhook', { status: 404 }));
    await createNotifier({ discord: SECRET_URL }, fetchImpl as unknown as typeof fetch)(event);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(logged(warn)).toMatch(/discord\.com: HTTP 404/);
    expect(logged(warn)).not.toMatch(/s3cret/);
  });

  it('logs network errors without the URL and never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => { throw new Error('connect ECONNREFUSED'); });
    await createNotifier({ slack: 'https://hooks.slack.com/services/T/B/s3cret' }, fetchImpl as unknown as typeof fetch)(event);
    expect(logged(warn)).toMatch(/hooks\.slack\.com: connect ECONNREFUSED/);
    expect(logged(warn)).not.toMatch(/s3cret/);
  });

  it('skips an invalid URL without echoing it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn();
    await createNotifier({ discord: 'not a url s3cret' }, fetchImpl as unknown as typeof fetch)(event);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logged(warn)).not.toMatch(/s3cret/);
  });

  it('stays quiet on success', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await createNotifier({ discord: SECRET_URL }, fetchImpl as unknown as typeof fetch)(event);
    expect(warn).not.toHaveBeenCalled();
  });
});
