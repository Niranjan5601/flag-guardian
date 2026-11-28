import { describe, expect, it } from 'vitest';
import { COMMENT_MARKER, countRiskier, diffConfigs, fmtDuration, md, plain, renderMarkdown, renderText } from '../src/config/diff.js';
import { parseConfig, validateConfigText } from '../src/config/load.js';

const BASE = `
version: 1
flagsmith: { project: demo-shop, environment: Production }
notify: { discord: \${DISCORD_WEBHOOK_URL} }
metrics:
  error_rate: { source: prometheus, query: "x" }
  p95: { source: prometheus, query: "y" }
  requests: { source: prometheus, query: "z" }
flags:
  new_checkout:
    owner: "@payments-team"
    rollout: { steps: [5, 25, 50, 100], interval: 30s, samples: requests, min_samples: 15 }
    guards: [{ metric: error_rate, max: 0.02 }, { metric: p95, max: 400 }]
    on_breach: rollback
`;

const cfg = (yaml: string) => parseConfig(yaml, {});
const changesOf = (head: string, base = BASE) => diffConfigs(cfg(base), cfg(head)).flags[0]?.changes ?? [];
const riskOfVs = (head: string, base: string, what: string) => changesOf(head, base).find((c) => c.what === what)?.risk;
const riskOf = (head: string, what: string) => riskOfVs(head, BASE, what);

describe('diff: risk classification', () => {
  it('no change, no rows', () => {
    expect(diffConfigs(cfg(BASE), cfg(BASE))).toEqual({ flags: [], metrics: [], target: [] });
  });

  it('a higher first step or fewer steps is riskier; the opposite is safer', () => {
    expect(riskOf(BASE.replace('[5, 25, 50, 100]', '[50, 100]'), 'Steps')).toBe('riskier');
    expect(riskOf(BASE.replace('[5, 25, 50, 100]', '[1, 5, 25, 50, 100]'), 'Steps')).toBe('safer');
    expect(riskOf(BASE.replace('[5, 25, 50, 100]', '[1, 100]'), 'Steps')).toBe('review'); // lower start, fewer steps
  });

  it('a shorter interval or fewer min samples is riskier', () => {
    expect(riskOf(BASE.replace('interval: 30s', 'interval: 5s'), 'Interval')).toBe('riskier');
    expect(riskOf(BASE.replace('interval: 30s', 'interval: 2m'), 'Interval')).toBe('safer');
    expect(riskOf(BASE.replace('min_samples: 15', 'min_samples: 1'), 'Min samples')).toBe('riskier');
  });

  it('loosening or removing a guard is riskier; tightening or adding one is safer', () => {
    expect(riskOf(BASE.replace('max: 0.02', 'max: 0.2'), 'Guard error_rate max')).toBe('riskier');
    expect(riskOf(BASE.replace('max: 0.02', 'max: 0.01'), 'Guard error_rate max')).toBe('safer');
    expect(riskOf(BASE.replace(', { metric: p95, max: 400 }', ''), 'Guard p95 max')).toBe('riskier');
    expect(riskOf(BASE.replace('{ metric: p95, max: 400 }', '{ metric: p95, max: 400 }, { metric: requests, min: 1 }'), 'Guard requests min')).toBe('safer');
  });

  it('compares the strictest guard when a metric has several', () => {
    // adding a looser duplicate does not loosen anything: the 0.02 limit still applies
    expect(changesOf(BASE.replace('{ metric: p95, max: 400 }', '{ metric: p95, max: 400 }, { metric: error_rate, max: 0.5 }'))).toEqual([]);
  });

  it('switching from rollback to hold is riskier', () => {
    expect(riskOf(BASE.replace('on_breach: rollback', 'on_breach: hold'), 'On breach')).toBe('riskier');
  });

  it('reports added and removed flags, and metric queries that change what healthy means', () => {
    const d = diffConfigs(cfg(BASE), cfg(BASE.replace('new_checkout:', 'other_flag:').replace('query: "x"', 'query: "x2"')));
    expect(d.flags.map((f) => [f.flag, f.status])).toEqual([['other_flag', 'added'], ['new_checkout', 'removed']]);
    expect(d.metrics).toEqual([{ metric: 'error_rate', status: 'changed', usedBy: ['other_flag'] }]);
  });

  it('with no base, every flag is new and no metric is reported as changed', () => {
    const d = diffConfigs(null, cfg(BASE));
    expect(d.flags).toHaveLength(1);
    expect(d.flags[0].status).toBe('added');
    expect(d.metrics).toEqual([]);
  });

  it('compares exposure at every step: a raised ceiling or a faster climb is riskier', () => {
    const base = BASE.replace('[5, 25, 50, 100]', '[5, 25, 50]');
    expect(riskOfVs(BASE, base, 'Steps')).toBe('riskier'); // same start, now reaches 100%
    expect(riskOfVs(base, BASE, 'Steps')).toBe('safer');
    expect(riskOf(BASE.replace('[5, 25, 50, 100]', '[5, 75, 90, 100]'), 'Steps')).toBe('riskier'); // same length, start, end
    expect(riskOf(BASE.replace('[5, 25, 50, 100]', '[10, 20, 30, 40, 100]'), 'Steps')).toBe('review'); // more at first, less later
  });

  it('a shorter watch window is riskier, counting from the 10 minute default', () => {
    expect(riskOf(BASE.replace('on_breach: rollback', 'on_breach: rollback\n    watch_manual_changes: 1m'), 'Watch manual changes')).toBe('riskier');
    expect(riskOf(BASE.replace('on_breach: rollback', 'on_breach: rollback\n    watch_manual_changes: 1h'), 'Watch manual changes')).toBe('safer');
    expect(changesOf(BASE.replace('on_breach: rollback', 'on_breach: rollback\n    watch_manual_changes: 10m'))).toEqual([]);
  });

  it('hold to rollback is safer; owner and description changes are info only', () => {
    const hold = BASE.replace('on_breach: rollback', 'on_breach: hold');
    expect(riskOfVs(BASE, hold, 'On breach')).toBe('safer'); // head rollback, base hold
    expect(riskOf(BASE.replace('@payments-team', '@other-team'), 'Owner')).toBe('info');
  });

  it('a changed project or environment needs review; removed and added metrics are listed', () => {
    const head = BASE.replace('environment: Production', 'environment: Staging').replace('  requests: { source: prometheus, query: "z" }', '  requests: { source: prometheus, query: "z" }\n  extra: { source: prometheus, query: "e" }');
    const d = diffConfigs(cfg(BASE), cfg(head));
    expect(d.target).toEqual([{ what: 'Flagsmith environment', before: 'Production', after: 'Staging', risk: 'review' }]);
    expect(d.metrics).toEqual([{ metric: 'extra', status: 'added', usedBy: [] }]);
    expect(diffConfigs(cfg(head), cfg(BASE)).metrics).toEqual([{ metric: 'extra', status: 'removed', usedBy: [] }]);
  });

  it('formats durations, including 0', () => {
    expect([0, 1500, 30_000, 120_000, 3_600_000].map(fmtDuration)).toEqual(['0s', '1500ms', '30s', '2m', '1h']);
  });

  it('counts riskier changes', () => {
    const head = BASE.replace('[5, 25, 50, 100]', '[50, 100]').replace('max: 0.02', 'max: 0.2');
    expect(countRiskier(diffConfigs(cfg(BASE), cfg(head)))).toBe(2);
  });
});

describe('diff: rendering', () => {
  it('markdown comment carries the marker, the verdict and the risky rows', () => {
    const head = validateConfigText(BASE.replace('[5, 25, 50, 100]', '[50, 100]'), { env: {} });
    const out = renderMarkdown({ file: 'flags.yaml', head, base: cfg(BASE) });
    expect(out.startsWith(COMMENT_MARKER)).toBe(true);
    expect(out).toContain('**Valid**');
    expect(out).toContain('**1 riskier change**');
    expect(out).toContain('| Steps | `5%, 25%, 50%, 100%` | `50%, 100%` | **riskier** |');
  });

  it('an invalid file lists the errors', () => {
    const head = validateConfigText(BASE.replace('metric: p95', 'metric: nope'), { env: {} });
    const out = renderMarkdown({ file: 'flags.yaml', head, base: cfg(BASE) });
    expect(out).toContain('**Invalid**');
    expect(out).toContain('unknown metric "nope"');
  });

  it('never expands ${VAR} secrets into the output', () => {
    const head = validateConfigText(BASE, { env: {} });
    expect(head.config!.notify.discord).toBeUndefined(); // unset variable = not configured, not invalid
    const prev = process.env.DISCORD_WEBHOOK_URL;
    process.env.DISCORD_WEBHOOK_URL = 'https://discord.example/secret-token';
    try {
      const out = renderMarkdown({ file: 'flags.yaml', head: validateConfigText(BASE, { env: {} }), base: null });
      expect(out).not.toContain('secret-token');
    } finally {
      if (prev === undefined) delete process.env.DISCORD_WEBHOOK_URL; else process.env.DISCORD_WEBHOOK_URL = prev;
    }
  });

  it('an empty notify section or empty webhook means "not configured", not invalid', () => {
    for (const notify of ['notify:', 'notify: null', 'notify: { discord: "", slack: null }']) {
      const c = cfg(BASE.replace('notify: { discord: ${DISCORD_WEBHOOK_URL} }', notify));
      expect(c.notify).toEqual({ discord: undefined, slack: undefined });
    }
    expect(cfg(BASE.replace('notify: { discord: ${DISCORD_WEBHOOK_URL} }', '')).notify).toEqual({ discord: undefined, slack: undefined });
  });

  it('free text cannot mention people, inject HTML or break the table', () => {
    expect(md('@payments-team')).toBe('`@payments-team`'); // inside code: GitHub does not notify
    expect(md('a | b')).toBe('`a   b`');
    expect(md('<img src=x onerror=alert(1)>')).not.toMatch(/[<>]/);
    expect(md('`break` out')).toBe('`break  out`');
    expect(md('')).toBe('–');
  });

  it('invisible and reordering characters are made visible, not passed through', () => {
    for (const hidden of ['\u202E', '\u2066', '\u200B', '\uFEFF', '\u2028', '\u0007', '\u001B[31m']) {
      const out = md(`a${hidden}b`);
      expect(out).not.toMatch(/[\u202E\u2066\u200B\uFEFF\u2028\u0007\u001B]/);
      expect(out.startsWith('`a')).toBe(true);
    }
    expect(md('a\u202Eb')).toBe('`a\uFFFDb`');
  });

  it('long values are cut by code point and marked', () => {
    const out = md('\u{1D400}'.repeat(300)); // outside the BMP: a surrogate pair in UTF-16
    expect(out.endsWith('…`')).toBe(true);
    expect([...out.slice(1, -2)]).toHaveLength(200);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/); // no lone high surrogate
  });

  it('metric names in guard labels are code, so "www.x" cannot become a link', () => {
    const head = BASE.replaceAll('p95', 'www.evil.example');
    const out = renderMarkdown({ file: 'flags.yaml', head: validateConfigText(head.replace('max: 400', 'max: 500'), { env: {} }), base: cfg(head) });
    expect(out).toContain('| Guard `www.evil.example` max | `400` | `500` | **riskier** |');
  });

  it('YAML errors (multi-line code frames) stay on one line in the comment', () => {
    const head = validateConfigText('version: 1\nflags: [\n  ::error::injected\n', { env: {} });
    expect(head.ok).toBe(false);
    const out = renderMarkdown({ file: 'flags.yaml', head, base: null });
    const errorLines = out.split('\n').filter((l) => l.startsWith('- '));
    expect(errorLines.length).toBe(head.errors.length);
    expect(out.split('\n').some((l) => l.startsWith('::'))).toBe(false);
  });

  it('a huge review is cut at a line break, under GitHub\'s comment limit', () => {
    const many = Array.from({ length: 600 }, (_, i) => `  f${i}:\n    description: "${'x'.repeat(150)}"\n    rollout: { steps: [5, 100], interval: 30s }\n    guards: [{ metric: p95, max: 400 }]`).join('\n');
    const head = validateConfigText(`${BASE}${many}\n`, { env: {} });
    const out = renderMarkdown({ file: 'flags.yaml', head, base: null });
    expect(out.length).toBeLessThan(65_536);
    expect(out).toMatch(/\n\n…\(truncated[^\n]*$/);
    for (const line of out.split('\n')) expect((line.match(/`/g) ?? []).length % 2).toBe(0); // no open code span
  });

  it('text output never lets file content start a log line or carry escape codes', () => {
    expect(plain('a\n::error::x\r\nb\u001B[2J')).toBe('a\n      ::error::x\n      b\uFFFD[2J');
    const head = validateConfigText(BASE.replace('owner: "@payments-team"', 'owner: "@a"\n    description: "line\\n::warning::boo"'), { env: {} });
    const out = renderText({ file: 'flags.yaml', head, base: cfg(BASE) });
    expect(out.split('\n').some((l) => l.startsWith('::'))).toBe(false);
  });

  it('says when the base did not parse', () => {
    expect(renderText({ file: 'flags.yaml', head: validateConfigText(BASE, { env: {} }), base: 'invalid' })).toMatch(/^⚠ the base version did not parse/);
  });

  it('text output is readable in a terminal', () => {
    const head = validateConfigText(BASE.replace('interval: 30s', 'interval: 5s'), { env: {} });
    expect(renderText({ file: 'flags.yaml', head, base: cfg(BASE) })).toBe('~ new_checkout\n    Interval: 30s → 5s  (riskier)');
    expect(renderText({ file: 'flags.yaml', head: validateConfigText(BASE, { env: {} }), base: cfg(BASE) })).toBe('No rollout changes.');
  });
});
