import { createHmac, timingSafeEqual } from 'node:crypto';

/** Verify `X-Flagsmith-Signature`: hex HMAC-SHA256 of the raw body, keyed with the webhook secret. */
export function verifySignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature.trim().toLowerCase(), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface FlagUpdated {
  feature: string;
  environment: string | undefined;
  changedBy: string | undefined;
  enabled: boolean | undefined;
  isSegmentOverride: boolean;
}

/** The parts of a Flagsmith FLAG_UPDATED webhook we read. Everything is optional: the body is untrusted. */
interface FeatureStatePayload {
  enabled?: unknown;
  feature?: { name?: unknown };
  environment?: { name?: unknown };
  feature_segment?: unknown;
}
interface WebhookPayload {
  event_type?: unknown;
  data?: { changed_by?: unknown; new_state?: FeatureStatePayload | null; previous_state?: FeatureStatePayload | null };
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** Pull the fields Guardian cares about out of a FLAG_UPDATED payload. Returns null for other events. */
export function parseFlagUpdated(body: unknown): FlagUpdated | null {
  const payload = (body ?? {}) as WebhookPayload;
  if (payload.event_type !== 'FLAG_UPDATED') return null;
  const s = payload.data?.new_state ?? payload.data?.previous_state;
  const feature = str(s?.feature?.name);
  if (!feature) return null;
  const enabled = payload.data?.new_state?.enabled;
  return {
    feature,
    environment: str(s?.environment?.name),
    changedBy: str(payload.data?.changed_by),
    enabled: typeof enabled === 'boolean' ? enabled : undefined,
    isSegmentOverride: !!s?.feature_segment,
  };
}
