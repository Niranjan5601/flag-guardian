import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { ZodError } from 'zod';
import { GuardianConfig } from './schema.js';

/** Replace ${VAR} with process.env.VAR (empty string when unset). */
function expandEnv(text: string, env: NodeJS.ProcessEnv = process.env): string {
  return text.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_, k) => env[k] ?? '');
}

export function parseConfig(text: string, env?: NodeJS.ProcessEnv): GuardianConfig {
  return GuardianConfig.parse(parse(expandEnv(text, env)));
}

export function loadConfig(path: string): GuardianConfig {
  return parseConfig(readFileSync(path, 'utf8'));
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  config?: GuardianConfig;
}

/**
 * `env` replaces process.env for ${VAR} expansion. CI review passes `{}` so secrets referenced in
 * flags.yaml (chat webhook URLs) are never expanded into output that ends up in a PR comment.
 */
export function validateConfigText(text: string, opts: { strict?: boolean; now?: Date; env?: NodeJS.ProcessEnv } = {}): ValidationResult {
  const now = opts.now ?? new Date();
  let config: GuardianConfig;
  try {
    config = parseConfig(text, opts.env);
  } catch (e) {
    if (e instanceof ZodError) {
      return { ok: false, warnings: [], errors: e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
    }
    return { ok: false, warnings: [], errors: [(e as Error).message] };
  }
  const warnings: string[] = [];
  for (const [name, flag] of Object.entries(config.flags)) {
    if (flag.expires && flag.expires < now) {
      warnings.push(`flags.${name}: expired on ${flag.expires.toISOString().slice(0, 10)}; remove the flag or extend "expires"`);
    }
    if (flag.rollout.steps.at(-1) !== 100) {
      warnings.push(`flags.${name}: last rollout step is ${flag.rollout.steps.at(-1)}%, not 100%`);
    }
  }
  const errors = opts.strict ? warnings.splice(0) : [];
  return { ok: errors.length === 0, errors, warnings, config };
}
