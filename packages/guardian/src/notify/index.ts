import type { GuardianEvent } from '../controller/types.js';

export interface NotifyConfig {
  discord?: string;
  slack?: string;
  grafanaUrl?: string;
  grafanaToken?: string;
  /** link added to chat messages, e.g. the Guardian UI */
  linkUrl?: string;
}

const COLORS: Partial<Record<GuardianEvent['type'], number>> = {
  started: 0x3b82f6,
  resumed: 0x3b82f6,
  step_advanced: 0x22c55e,
  completed: 0x16a34a,
  breach_detected: 0xf59e0b,
  holding: 0x94a3b8,
  held: 0xf97316,
  rolled_back: 0xef4444,
  manual_change_detected: 0xa855f7,
  watch_ended: 0x64748b,
  error: 0xef4444,
};

/** Events worth a chat message (holding/breach_detected are noisy; they stay in the UI). */
const CHAT_EVENTS = new Set<GuardianEvent['type']>([
  'started', 'resumed', 'step_advanced', 'completed', 'held', 'rolled_back', 'manual_change_detected', 'error',
]);

/** Slack treats <...> as links/mentions (e.g. <!channel>); escape per Slack's formatting rules. */
const slackEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const valuesLine = (v?: Record<string, number | null>) =>
  v && Object.keys(v).length
    ? Object.entries(v).map(([k, n]) => `${k}=${n === null ? '–' : +n.toFixed(4)}`).join('  ')
    : '';

/**
 * Host part of a URL, for log lines. Chat webhook URLs carry their secret token in the path
 * (and could carry user:password), so logs only ever show this.
 */
const hostOf = (url: string): string | undefined => {
  try { return new URL(url).host; } catch { return undefined; }
};

export function createNotifier(cfg: NotifyConfig, fetchImpl: typeof fetch = fetch) {
  const post = async (url: string, body: unknown, headers: Record<string, string> = {}): Promise<void> => {
    const host = hostOf(url);
    // fetch's own "Failed to parse URL from <url>" error would print the whole secret URL.
    if (!host) { console.warn('[notify] skipped: notification URL is not a valid URL'); return; }
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      // A revoked Discord webhook (404) or a bad Grafana token (401) does not throw; say so,
      // otherwise alerts silently stop arriving.
      if (!res.ok) console.warn(`[notify] ${host}: HTTP ${res.status}`);
      await res.body?.cancel().catch(() => {}); // response body is unused; free the connection
    } catch (e) {
      console.warn(`[notify] ${host}: ${(e as Error).message}`);
    }
  };

  return async (e: GuardianEvent) => {
    const jobs: Promise<unknown>[] = [];
    const metrics = valuesLine(e.values);

    if (CHAT_EVENTS.has(e.type)) {
      if (cfg.discord) {
        jobs.push(post(cfg.discord, {
          username: 'Flag Guardian',
          // Messages can contain text from webhooks (e.g. changed_by); never let it ping @everyone.
          allowed_mentions: { parse: [] },
          embeds: [{
            title: `${e.flag} · ${e.type.replace(/_/g, ' ')}`,
            description: e.message + (metrics ? `\n\`${metrics}\`` : ''),
            color: COLORS[e.type] ?? 0x64748b,
            url: cfg.linkUrl,
            footer: { text: `rollout ${e.percent ?? 0}%` },
            timestamp: new Date(e.ts).toISOString(),
          }],
        }));
      }
      if (cfg.slack) {
        jobs.push(post(cfg.slack, { text: slackEscape(`*${e.flag}* · ${e.message}${metrics ? `\n\`${metrics}\`` : ''}`) }));
      }
    }

    if (cfg.grafanaUrl && cfg.grafanaToken && e.type !== 'holding') {
      jobs.push(post(`${cfg.grafanaUrl.replace(/\/+$/, '')}/api/annotations`, {
        time: e.ts,
        tags: ['guardian', e.flag, e.type],
        text: `${e.flag}: ${e.message}`,
      }, { Authorization: `Bearer ${cfg.grafanaToken}` }));
    }
    await Promise.all(jobs);
  };
}
