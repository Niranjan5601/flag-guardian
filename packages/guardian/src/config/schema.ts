import { z } from 'zod';

/** "30s" | "2m" | "1h" → milliseconds */
const Duration = z
  .string()
  .regex(/^\d+(ms|s|m|h)$/, 'duration like 30s, 2m, 1h')
  .transform((v) => {
    const n = parseInt(v, 10);
    const unit = v.replace(/^\d+/, '');
    const mult = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[unit as 'ms' | 's' | 'm' | 'h'];
    return n * mult;
  });

/**
 * Flag and metric names: a conservative subset of Flagsmith feature names. No spaces or "/",
 * which would break the `guardian/<flag>` segment name and the /api/flags/<flag> URL; a leading
 * letter or digit, so "." / ".." can't be a path segment. Object.prototype names ("constructor",
 * "__proto__", ...) are refused because names are used as keys of plain objects.
 */
const Name = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'use letters, digits, "_", "-" or "." (start with a letter or digit)')
  .refine((n) => !(n in Object.prototype), (n) => ({ message: `"${n}" is a reserved name` }));

const Metric = z.discriminatedUnion('source', [
  z.object({ source: z.literal('prometheus'), query: z.string().min(1) }),
  z.object({
    source: z.literal('http'),
    url: z.string().url(),
    /** dot path to the number in the JSON response, e.g. "data.error_rate" */
    path: z.string().min(1),
  }),
]);

const Guard = z
  .object({
    metric: z.string(),
    max: z.number().optional(),
    min: z.number().optional(),
  })
  .refine((g) => g.max !== undefined || g.min !== undefined, 'guard needs max or min');

const Flag = z.object({
  description: z.string().optional(),
  owner: z.string().optional(),
  expires: z.coerce.date().optional(),
  environment: z.string().optional(),
  rollout: z.object({
    steps: z
      .array(z.number().int().min(1).max(100))
      .min(1)
      .refine((s) => s.every((v, i) => i === 0 || v > s[i - 1]), 'steps must strictly increase'),
    interval: Duration,
    /** metric returning the request count for the treated cohort; used with min_samples */
    samples: z.string().optional(),
    min_samples: z.number().int().nonnegative().default(0),
  }),
  guards: z.array(Guard).min(1),
  on_breach: z.enum(['rollback', 'hold']).default('rollback'),
  watch_manual_changes: Duration.optional(),
});

export const GuardianConfig = z
  .object({
    version: z.literal(1),
    flagsmith: z.object({
      project: z.string(),
      environment: z.string(),
    }),
    // nullish: an unset `${DISCORD_WEBHOOK_URL}` leaves `discord:`, which YAML reads as null.
    // That means "not configured", not an invalid file; same for a bare `notify:`.
    notify: z.preprocess(
      (v) => v ?? {},
      z.object({
        discord: z.string().nullish().transform((v) => v || undefined),
        slack: z.string().nullish().transform((v) => v || undefined),
      }),
    ),
    metrics: z.record(Name, Metric),
    flags: z.record(Name, Flag),
  })
  .superRefine((cfg, ctx) => {
    // Object.hasOwn, not `in`: `"constructor" in {}` is true, which would accept a guard on a
    // metric that does not exist (and that guard would then never fail).
    const isMetric = (m: string) => Object.hasOwn(cfg.metrics, m);
    for (const [name, flag] of Object.entries(cfg.flags)) {
      if (flag.rollout.samples && !isMetric(flag.rollout.samples)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['flags', name, 'rollout', 'samples'],
          message: `unknown metric "${flag.rollout.samples}" (define it under metrics:)`,
        });
      }
      // Without a samples metric the count is unknown, so the rollout would hold forever.
      if (flag.rollout.min_samples > 0 && !flag.rollout.samples) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['flags', name, 'rollout', 'min_samples'],
          message: 'min_samples needs rollout.samples (a metric that counts requests in the treated cohort)',
        });
      }
      flag.guards.forEach((g, i) => {
        if (!isMetric(g.metric)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['flags', name, 'guards', i, 'metric'],
            message: `unknown metric "${g.metric}" (define it under metrics:)`,
          });
        }
      });
    }
  });

/** How long Guardian watches the guards after a hand-made change when the flag sets no watch_manual_changes. */
export const DEFAULT_WATCH_MS = 10 * 60_000;

export type GuardianConfig = z.infer<typeof GuardianConfig>;
export type FlagPlan = GuardianConfig['flags'][string];
