import type { GuardianConfig } from '../config/schema.js';

export interface MetricReader {
  /** Current value of a named metric, or null when there is no data / the source is down. */
  read(name: string): Promise<number | null>;
}

const finite = (n: number) => (Number.isFinite(n) ? n : null);
const TIMEOUT_MS = 5000;

/** The parts of a Prometheus /api/v1/query response we read. */
interface PromResponse {
  data?: { resultType?: string; result?: unknown };
}
type PromSample = [number, string];

export class Metrics implements MetricReader {
  constructor(
    private defs: GuardianConfig['metrics'],
    private prometheusUrl: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async read(name: string): Promise<number | null> {
    if (!Object.hasOwn(this.defs, name)) return null;
    const def = this.defs[name];
    try {
      if (def.source === 'prometheus') return await this.prom(def.query);
      return await this.http(def.url, def.path);
    } catch {
      return null;
    }
  }

  private async prom(query: string): Promise<number | null> {
    const url = `${this.prometheusUrl.replace(/\/+$/, '')}/api/v1/query?query=${encodeURIComponent(query)}`;
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const body = (await res.json()) as PromResponse;
    const r = body?.data?.result;
    if (body?.data?.resultType === 'scalar') return finite(parseFloat((r as PromSample | undefined)?.[1] ?? ''));
    if (!Array.isArray(r) || r.length === 0) return null;
    // A query returning several series is ambiguous; guards are expected to aggregate (sum/max) to one.
    return finite(parseFloat((r[0] as { value?: PromSample }).value?.[1] ?? ''));
  }

  private async http(url: string, path: string): Promise<number | null> {
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    let v: unknown = await res.json();
    for (const key of path.split('.')) {
      v = v !== null && typeof v === 'object' && Object.hasOwn(v, key) ? (v as Record<string, unknown>)[key] : undefined;
    }
    return typeof v === 'number' ? finite(v) : typeof v === 'string' ? finite(parseFloat(v)) : null;
  }
}
