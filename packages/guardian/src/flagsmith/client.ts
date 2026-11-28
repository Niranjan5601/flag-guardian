/**
 * Thin client for the Flagsmith Admin (Management) API.
 * Every Flagsmith call Guardian makes goes through this file.
 *
 * Verified against self-hosted Flagsmith (image built 2026-11-23):
 *  - auth header `Authorization: Api-Key <org key>`
 *  - `% Split` = condition operator PERCENTAGE_SPLIT, property "$.identity.key"
 *  - flag state via /api/__future__/environments/{env client key}/features/{id}/
 *  - segment override body: { segment: { id }, enabled, priority }
 */

export class FlagsmithError extends Error {
  constructor(
    public status: number,
    public method: string,
    public path: string,
    public body: unknown,
  ) {
    super(`Flagsmith ${method} ${path} → ${status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
}

export interface Project { id: number; name: string }
export interface Environment { id: number; name: string; api_key: string }
export interface Feature { id: number; name: string; description?: string | null }
export interface Condition { id?: number; operator: string; property: string; value: string }
export interface Rule { id?: number; type: 'ALL' | 'ANY' | 'NONE'; rules: Rule[]; conditions: Condition[] }
export interface Segment { id: number; name: string; project: number; description?: string | null; rules: Rule[] }
export interface SegmentOverride { segment: { id: number }; enabled: boolean; priority: number; value?: unknown; variants?: unknown[] }
export interface FlagState {
  environment_default: { enabled: boolean; value: unknown; variants: unknown[] };
  segment_overrides: SegmentOverride[];
}

const SPLIT_PROPERTY = '$.identity.key';

export function splitRules(percent: number): Rule[] {
  return [
    {
      type: 'ALL',
      conditions: [],
      rules: [
        {
          type: 'ANY',
          rules: [],
          conditions: [{ operator: 'PERCENTAGE_SPLIT', property: SPLIT_PROPERTY, value: String(percent) }],
        },
      ],
    },
  ];
}

/** Find the PERCENTAGE_SPLIT condition anywhere in a rule tree. */
export function findSplit(rules: Rule[]): Condition | undefined {
  for (const r of rules) {
    const c = r.conditions.find((x) => x.operator === 'PERCENTAGE_SPLIT');
    if (c) return c;
    const nested = findSplit(r.rules ?? []);
    if (nested) return nested;
  }
  return undefined;
}

export class FlagsmithClient {
  private root: string;

  /**
   * @param apiUrl e.g. http://localhost:8000/api/v1/
   * @param timeoutMs per request. Without it a hung Flagsmith would block the tick (and the
   *   per-flag lock, so also a manual rollback) forever.
   */
  constructor(apiUrl: string, private apiKey: string, private fetchImpl: typeof fetch = fetch, private timeoutMs = 10_000) {
    this.root = apiUrl.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  }

  async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(this.root + path, {
      method,
      headers: { Authorization: `Api-Key ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    }).catch((e: Error) => {
      throw new Error(`Flagsmith ${method} ${path} failed: ${e.message}`);
    });
    const text = await res.text();
    let json: unknown = text;
    try { json = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    if (!res.ok) throw new FlagsmithError(res.status, method, path, json);
    return json as T;
  }

  /** GET a list endpoint, following pagination if present. */
  async list<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let next: string | null = path;
    while (next) {
      const page: unknown = await this.req('GET', next);
      if (Array.isArray(page)) return page as T[];
      const p = page as { results: T[]; next: string | null };
      out.push(...p.results);
      next = p.next ? p.next.replace(/^https?:\/\/[^/]+/, '') : null;
    }
    return out;
  }

  async findProject(name: string): Promise<Project | undefined> {
    return (await this.list<Project>('/api/v1/projects/')).find((p) => p.name === name);
  }

  async findEnvironment(projectId: number, name: string): Promise<Environment | undefined> {
    return (await this.list<Environment>(`/api/v1/environments/?project=${projectId}`)).find((e) => e.name === name);
  }

  async findFeature(projectId: number, name: string): Promise<Feature | undefined> {
    const q = encodeURIComponent(name);
    return (await this.list<Feature>(`/api/v1/projects/${projectId}/features/?search=${q}`)).find((f) => f.name === name);
  }

  createFeature(projectId: number, name: string, description?: string): Promise<Feature> {
    return this.req('POST', `/api/v1/projects/${projectId}/features/`, {
      name,
      description: description ?? '',
      default_enabled: false,
    });
  }

  async findSegment(projectId: number, name: string): Promise<Segment | undefined> {
    const q = encodeURIComponent(name);
    return (await this.list<Segment>(`/api/v1/projects/${projectId}/segments/?q=${q}`)).find((s) => s.name === name);
  }

  getSegment(projectId: number, segmentId: number): Promise<Segment> {
    return this.req('GET', `/api/v1/projects/${projectId}/segments/${segmentId}/`);
  }

  createSplitSegment(projectId: number, name: string, percent: number): Promise<Segment> {
    return this.req('POST', `/api/v1/projects/${projectId}/segments/`, {
      name,
      project: projectId,
      description: 'Managed by Flag Guardian. Do not edit by hand.',
      rules: splitRules(percent),
    });
  }

  /** Change the % of a split segment in place (keeps rule/condition ids). */
  async setSegmentSplit(projectId: number, segmentId: number, percent: number): Promise<Segment> {
    const seg = await this.getSegment(projectId, segmentId);
    const cond = findSplit(seg.rules);
    const rules = cond ? seg.rules : splitRules(percent);
    if (cond) cond.value = String(percent);
    // PUT is a full update: send the description back so the "Managed by Flag Guardian" note
    // is not cleared on every step change. Omitted when absent rather than sent as null.
    return this.req('PUT', `/api/v1/projects/${projectId}/segments/${segmentId}/`, {
      name: seg.name,
      project: projectId,
      ...(typeof seg.description === 'string' && { description: seg.description }),
      rules,
    });
  }

  getFlag(envKey: string, featureId: number): Promise<FlagState> {
    return this.req('GET', `/api/__future__/environments/${envKey}/features/${featureId}/`);
  }

  patchFlag(envKey: string, featureId: number, body: Partial<{ environment_default: { enabled: boolean }; segment_overrides: SegmentOverride[] }>): Promise<unknown> {
    return this.req('PATCH', `/api/__future__/environments/${envKey}/features/${featureId}/`, body);
  }

  /** Remove one segment override. Missing override is not an error. */
  async deleteOverride(envKey: string, featureId: number, segmentId: number): Promise<void> {
    try {
      await this.req('DELETE', `/api/__future__/environments/${envKey}/features/${featureId}/segment-overrides/${segmentId}/`);
    } catch (e) {
      if (e instanceof FlagsmithError && e.status === 404) return;
      throw e;
    }
  }
}
