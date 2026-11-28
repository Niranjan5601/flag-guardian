import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// Runs the real CLI (through tsx, no build needed) in an empty temp dir, so no .env is loaded.
const pkg = resolve(import.meta.dirname, '..');
const tsx = pathToFileURL(join(pkg, 'node_modules/tsx/dist/loader.mjs')).href;
const cli = join(pkg, 'src/cli.ts');
const dir = mkdtempSync(join(tmpdir(), 'guardian-diff-'));
const flags = readFileSync(join(pkg, '../../flags.yaml'), 'utf8');

function diff(head: string, args: string[], stdin?: string) {
  writeFileSync(join(dir, 'head.yaml'), head);
  const r = spawnSync(process.execPath, ['--import', tsx, cli, '--config', 'head.yaml', 'diff', ...args], {
    cwd: dir, input: stdin, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('guardian diff (CLI)', { timeout: 60_000 }, () => {
  const risky = flags.replace('steps: [5, 25, 50, 100]', 'steps: [50, 100]');
  writeFileSync(join(dir, 'base.yaml'), flags);

  it('exit 0 without --fail-on-riskier, 2 with it, 1 when invalid', () => {
    expect(diff(risky, ['--base', 'base.yaml']).code).toBe(0);
    expect(diff(risky, ['--base', 'base.yaml', '--fail-on-riskier'])).toMatchObject({ code: 2 });
    expect(diff(flags, ['--base', 'base.yaml', '--fail-on-riskier'])).toMatchObject({ code: 0, out: 'No rollout changes.\n' });
    expect(diff(flags.replace('metric: error_rate', 'metric: nope'), ['--base', 'base.yaml']).code).toBe(1);
  });

  it('reads the base from stdin with "-"', () => {
    const r = diff(risky, ['--base', '-', '--fail-on-riskier'], flags);
    expect(r.code).toBe(2);
    expect(r.out).toContain('(riskier)');
  });

  it('a --base that cannot be read is an error, never "every flag is new"', () => {
    const r = diff(risky, ['--base', 'missing.yaml', '--fail-on-riskier']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/cannot read missing\.yaml/);
    expect(r.out).toBe('');
  });
});
