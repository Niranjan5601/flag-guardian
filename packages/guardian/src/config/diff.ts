import { DEFAULT_WATCH_MS, type FlagPlan, type GuardianConfig } from './schema.js';
import type { ValidationResult } from './load.js';

/**
 * Offline review of a flags.yaml change: compares the base branch's config with the PR's and
 * classifies every rollout-relevant difference. Runs in CI, so it never talks to Flagsmith.
 */

/** riskier: exposes more users sooner or weakens a safety check. safer: the opposite. review: a human must judge. */
export type Risk = 'riskier' | 'safer' | 'review' | 'info';

type Bound = 'max' | 'min';

export interface Change {
  what: string;
  before: string;
  after: string;
  risk: Risk;
  /** set on guard rows, so the markdown renderer can format the (user-chosen) metric name safely */
  guard?: { metric: string; bound: Bound };
}
export interface FlagChange { flag: string; status: 'added' | 'removed' | 'changed'; changes: Change[] }
export interface MetricChange { metric: string; status: 'added' | 'removed' | 'changed'; usedBy: string[] }

export interface ConfigDiff {
  flags: FlagChange[];
  metrics: MetricChange[];
  /** project / environment the whole file targets */
  target: Change[];
}

export function fmtDuration(ms: number): string {
  if (ms === 0) return '0s'; // 0 is divisible by everything; "0h" would read oddly
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}

/** Commas, not arrows: the before → after column already uses an arrow. */
const steps = (s: number[]) => s.map((v) => `${v}%`).join(', ');
const sign = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0);
const byScore = (score: number): Risk => (score > 0 ? 'riskier' : score < 0 ? 'safer' : 'review');

/**
 * Compares the share of users exposed after each interval. After its last step a plan stays at
 * that percentage. Riskier only if the new plan exposes at least as many users at every point and
 * more at some point; safer is the mirror image; anything mixed (lower start, faster climb) is review.
 */
function stepRisk(a: number[], b: number[]): Risk {
  let more = false, less = false;
  for (let t = 0; t < Math.max(a.length, b.length); t++) {
    const x = a[Math.min(t, a.length - 1)], y = b[Math.min(t, b.length - 1)];
    if (y > x) more = true;
    else if (y < x) less = true;
  }
  return more && !less ? 'riskier' : less && !more ? 'safer' : 'review';
}

interface GuardLimit { metric: string; bound: Bound; limit: number }

/**
 * Effective limit per metric and direction. With several guards on the same metric the
 * strictest one decides (lowest max, highest min), so that is what we compare.
 */
function guardLimits(plan: FlagPlan): Map<string, GuardLimit> {
  const out = new Map<string, GuardLimit>();
  const add = (metric: string, bound: Bound, limit: number) => {
    const k = `${metric} ${bound}`;
    const prev = out.get(k)?.limit;
    const strictest = prev === undefined ? limit : bound === 'max' ? Math.min(prev, limit) : Math.max(prev, limit);
    out.set(k, { metric, bound, limit: strictest });
  };
  for (const g of plan.guards) {
    if (g.max !== undefined) add(g.metric, 'max', g.max);
    if (g.min !== undefined) add(g.metric, 'min', g.min);
  }
  return out;
}

function describePlan(plan: FlagPlan): Change[] {
  const row = (what: string, after: string): Change => ({ what, before: '', after, risk: 'info' });
  const rows: Change[] = [row('Steps', steps(plan.rollout.steps)), row('Interval', fmtDuration(plan.rollout.interval))];
  if (plan.rollout.samples) rows.push(row('Samples metric', plan.rollout.samples));
  if (plan.rollout.min_samples) rows.push(row('Min samples', String(plan.rollout.min_samples)));
  for (const { metric, bound, limit } of guardLimits(plan).values()) {
    rows.push({ ...row(`Guard ${metric} ${bound}`, String(limit)), guard: { metric, bound } });
  }
  rows.push(row('On breach', plan.on_breach));
  if (plan.watch_manual_changes !== undefined) rows.push(row('Watch manual changes', fmtDuration(plan.watch_manual_changes)));
  if (plan.environment) rows.push(row('Environment', plan.environment));
  return rows;
}

function diffFlag(a: FlagPlan, b: FlagPlan): Change[] {
  const out: Change[] = [];
  const push = (what: string, before: string, after: string, risk: Risk) => { if (before !== after) out.push({ what, before, after, risk }); };

  push('Steps', steps(a.rollout.steps), steps(b.rollout.steps), stepRisk(a.rollout.steps, b.rollout.steps));
  push('Interval', fmtDuration(a.rollout.interval), fmtDuration(b.rollout.interval), byScore(sign(a.rollout.interval - b.rollout.interval)));
  push('Min samples', String(a.rollout.min_samples), String(b.rollout.min_samples), byScore(sign(a.rollout.min_samples - b.rollout.min_samples)));
  push('Samples metric', a.rollout.samples ?? '–', b.rollout.samples ?? '–', 'review');

  const ga = guardLimits(a), gb = guardLimits(b);
  for (const k of new Set([...ga.keys(), ...gb.keys()])) {
    const before = ga.get(k), after = gb.get(k);
    if (before?.limit === after?.limit) continue;
    const { metric, bound } = (after ?? before)!;
    let risk: Risk;
    if (!after) risk = 'riskier';       // guard removed
    else if (!before) risk = 'safer';   // guard added
    else risk = byScore(bound === 'max' ? sign(after.limit - before.limit) : sign(before.limit - after.limit)); // looser = riskier
    out.push({
      what: `Guard ${metric} ${bound}`,
      before: before ? String(before.limit) : '–',
      after: after ? String(after.limit) : 'removed',
      risk,
      guard: { metric, bound },
    });
  }

  push('On breach', a.on_breach, b.on_breach, a.on_breach === 'rollback' ? 'riskier' : 'safer');
  // A shorter watch window stops checking the guards sooner after a hand-made change.
  const wa = a.watch_manual_changes ?? DEFAULT_WATCH_MS, wb = b.watch_manual_changes ?? DEFAULT_WATCH_MS;
  push('Watch manual changes', fmtDuration(wa), fmtDuration(wb), byScore(sign(wa - wb)));
  push('Environment', a.environment ?? '(default)', b.environment ?? '(default)', 'review');
  push('Expires', a.expires?.toISOString().slice(0, 10) ?? '–', b.expires?.toISOString().slice(0, 10) ?? '–', 'info');
  push('Owner', a.owner ?? '–', b.owner ?? '–', 'info');
  push('Description', a.description ?? '–', b.description ?? '–', 'info');
  return out;
}

// The schema already refuses Object.prototype names; hasOwn keeps this file correct on its own.
const own = (o: object, k: string) => Object.hasOwn(o, k);

export function diffConfigs(base: GuardianConfig | null, head: GuardianConfig): ConfigDiff {
  const target: Change[] = [];
  if (base) {
    if (base.flagsmith.project !== head.flagsmith.project) target.push({ what: 'Flagsmith project', before: base.flagsmith.project, after: head.flagsmith.project, risk: 'review' });
    if (base.flagsmith.environment !== head.flagsmith.environment) target.push({ what: 'Flagsmith environment', before: base.flagsmith.environment, after: head.flagsmith.environment, risk: 'review' });
  }

  const flags: FlagChange[] = [];
  const baseFlags = base?.flags ?? {};
  for (const name of Object.keys(head.flags)) {
    if (!own(baseFlags, name)) flags.push({ flag: name, status: 'added', changes: describePlan(head.flags[name]) });
    else {
      const changes = diffFlag(baseFlags[name], head.flags[name]);
      if (changes.length) flags.push({ flag: name, status: 'changed', changes });
    }
  }
  for (const name of Object.keys(baseFlags)) {
    if (!own(head.flags, name)) flags.push({ flag: name, status: 'removed', changes: [] });
  }

  // A metric's query decides what "healthy" means, so any change to one in use needs a human.
  // Without a base there is nothing to compare, so no metric is reported.
  const metrics: MetricChange[] = [];
  if (base) {
    const usedBy = (m: string) => Object.entries(head.flags)
      .filter(([, f]) => f.guards.some((g) => g.metric === m) || f.rollout.samples === m)
      .map(([n]) => n);
    for (const m of Object.keys(head.metrics)) {
      // zod emits keys in schema order, so JSON.stringify compares definitions reliably.
      if (!own(base.metrics, m)) metrics.push({ metric: m, status: 'added', usedBy: usedBy(m) });
      else if (JSON.stringify(base.metrics[m]) !== JSON.stringify(head.metrics[m])) metrics.push({ metric: m, status: 'changed', usedBy: usedBy(m) });
    }
    for (const m of Object.keys(base.metrics)) {
      if (!own(head.metrics, m)) metrics.push({ metric: m, status: 'removed', usedBy: [] });
    }
  }
  return { flags, metrics, target };
}

// --- rendering

const ICON: Record<Risk, string> = { riskier: '**riskier**', safer: 'safer', review: 'review', info: '' };

/**
 * Invisible or reordering characters: control codes, bidi overrides (U+202E, "Trojan Source"),
 * zero-width characters, line/paragraph separators. A reviewer must see that something is there,
 * so they become U+FFFD instead of vanishing. This also breaks emoji joined with U+200D; an
 * acceptable price for a review comment.
 */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const MAX_VALUE = 200; // characters (code points) of one value in the comment

/**
 * Text from flags.yaml goes into a public PR comment. Put it inside inline code with the
 * characters that could break out removed: no @mentions, links or HTML (code spans are
 * rendered literally), no table breakage (`|`), no closing backtick, one line only.
 */
export function md(text: string): string {
  const flat = text.replace(/\s/g, ' ').replace(HIDDEN, '\uFFFD').replace(/[`|<>\\]/g, ' ').trim();
  const chars = [...flat]; // by code point, so a cut never splits a surrogate pair
  const clean = chars.length > MAX_VALUE ? `${chars.slice(0, MAX_VALUE).join('')}…` : flat;
  return clean ? `\`${clean}\`` : '–';
}

/**
 * Terminal / CI-log text: no escape sequences, and continuation lines are indented so nothing from
 * the file starts a line (GitHub reads lines starting with `::` in a job log as workflow commands).
 */
export function plain(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(HIDDEN, (c) => (c === '\n' ? '\n      ' : '\uFFFD'));
}

/** Must stay identical to the marker action.yml searches for when it updates its comment. */
export const COMMENT_MARKER = '<!-- flag-guardian-plan -->';
const MAX_COMMENT = 60_000; // GitHub's limit is 65,536 characters

export interface ReviewInput {
  file: string;
  head: ValidationResult;
  /** null: no base version (new file or not a PR); 'invalid': base did not parse */
  base: GuardianConfig | null | 'invalid';
}

export function countRiskier(d: ConfigDiff): number {
  return d.flags.reduce((n, f) => n + f.changes.filter((c) => c.risk === 'riskier').length, 0);
}

/** Labels are fixed text except a guard's metric name, which comes from the file. */
const label = (c: Change) => (c.guard ? `Guard ${md(c.guard.metric)} ${c.guard.bound}` : c.what);

export function renderMarkdown({ file, head, base }: ReviewInput): string {
  const lines: string[] = [COMMENT_MARKER, `### Flag Guardian review of ${md(file)}`, ''];
  if (!head.ok || !head.config) {
    lines.push('**Invalid**: Guardian would refuse to load this file.', '');
    for (const e of head.errors) lines.push(`- ${md(e)}`);
    return finish(lines);
  }
  const diff = diffConfigs(base === 'invalid' ? null : base, head.config);
  const n = Object.keys(head.config.flags).length;
  const riskier = countRiskier(diff);
  lines.push(`**Valid** · ${n} guarded flag${n === 1 ? '' : 's'}${riskier ? ` · **${riskier} riskier change${riskier === 1 ? '' : 's'}**` : ''}`, '');
  if (base === 'invalid') lines.push('> The base branch version did not parse, so every flag is shown as new.', '');
  for (const w of head.warnings) lines.push(`> **Warning:** ${md(w)}`);
  if (head.warnings.length) lines.push('');

  for (const c of diff.target) lines.push(`**${c.what}** changed (review): ${md(c.before)} → ${md(c.after)}`, '');

  if (!diff.flags.length && !diff.metrics.length && !diff.target.length && base && base !== 'invalid') {
    lines.push('No rollout changes.', '');
  }
  for (const f of diff.flags) {
    if (f.status === 'removed') {
      lines.push(`#### ${md(f.flag)}: removed`, '', 'Guardian stops watching this flag. If it is mid-rollout, check its state in Flagsmith.', '');
      continue;
    }
    lines.push(`#### ${md(f.flag)}: ${f.status === 'added' ? 'new guarded flag' : 'changed'}`, '');
    if (f.status === 'added') {
      lines.push('| Setting | Value |', '|---|---|');
      for (const c of f.changes) lines.push(`| ${label(c)} | ${md(c.after)} |`);
    } else {
      lines.push('| Setting | Before | After | |', '|---|---|---|---|');
      for (const c of f.changes) lines.push(`| ${label(c)} | ${md(c.before)} | ${md(c.after)} | ${ICON[c.risk]} |`);
    }
    lines.push('');
  }
  if (diff.metrics.length) {
    lines.push('#### Metric definitions', '');
    for (const m of diff.metrics) {
      const used = m.usedBy.length ? `, used by ${m.usedBy.map(md).join(', ')}` : '';
      lines.push(`- ${md(m.metric)}: ${m.status}${used}${m.status === 'changed' && m.usedBy.length ? ' (review: this changes what "healthy" means)' : ''}`);
    }
    lines.push('');
  }
  lines.push('<sub>Offline review: compares this branch with the base branch. Flagsmith is not contacted.</sub>');
  return finish(lines);
}

/** Cut at a line break, so a truncated comment never ends inside a code span or table row. */
function finish(lines: string[]): string {
  const out = lines.join('\n');
  if (out.length <= MAX_COMMENT) return out;
  return `${out.slice(0, out.lastIndexOf('\n', MAX_COMMENT))}\n\n…(truncated: run \`guardian diff\` locally for the full review)`;
}

export function renderText({ file, head, base }: ReviewInput): string {
  const lines: string[] = [];
  if (!head.ok || !head.config) {
    lines.push(`✖ ${plain(file)} is invalid:`, ...head.errors.map((e) => `  - ${plain(e)}`));
    return lines.join('\n');
  }
  const diff = diffConfigs(base === 'invalid' ? null : base, head.config);
  if (base === 'invalid') lines.push('⚠ the base version did not parse, so every flag is shown as new');
  for (const w of head.warnings) lines.push(`⚠ ${plain(w)}`);
  for (const c of diff.target) lines.push(`~ ${c.what}: ${plain(c.before)} → ${plain(c.after)}  (review)`);
  for (const f of diff.flags) {
    const mark = { added: '+', removed: '-', changed: '~' }[f.status];
    lines.push(`${mark} ${f.flag}${f.status === 'removed' ? ' (no longer guarded)' : ''}`);
    for (const c of f.changes) {
      lines.push(f.status === 'added'
        ? `    ${c.what}: ${plain(c.after)}`
        : `    ${c.what}: ${plain(c.before)} → ${plain(c.after)}${c.risk === 'info' ? '' : `  (${c.risk})`}`);
    }
  }
  for (const m of diff.metrics) lines.push(`~ metric ${m.metric}: ${m.status}${m.usedBy.length ? ` (used by ${m.usedBy.join(', ')})` : ''}`);
  if (lines.length === 0) lines.push('No rollout changes.');
  return lines.join('\n');
}
