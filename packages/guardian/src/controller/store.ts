import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { FlagRuntime, GuardianEvent } from './types.js';

export interface Store {
  load(): Record<string, FlagRuntime>;
  save(flags: Record<string, FlagRuntime>): void;
  append(event: GuardianEvent): void;
  recent(limit?: number): GuardianEvent[];
}

/** JSON state file + JSONL event log in a data directory. */
export class FileStore implements Store {
  private events: GuardianEvent[] = [];

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
    const log = join(dir, 'events.jsonl');
    if (existsSync(log)) {
      // A crash mid-append can leave a truncated last line; skip it rather than refuse to start.
      this.events = readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .slice(-500)
        .flatMap((l) => {
          try { return [JSON.parse(l) as GuardianEvent]; } catch { return []; }
        });
    }
  }

  load(): Record<string, FlagRuntime> {
    const f = join(this.dir, 'state.json');
    if (!existsSync(f)) return {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(f, 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, FlagRuntime>;
      throw new Error('not a JSON object');
    } catch (e) {
      // Like a broken events.jsonl line: don't refuse to start (e.g. after a bad hand edit).
      // Keep the file for inspection and start fresh. Every flag then starts idle, so a rollout
      // that was in progress is no longer driven: the warning tells the operator to check it.
      const aside = `${f}.corrupt-${Date.now()}`;
      renameSync(f, aside);
      console.warn(`⚠ ${f} is unreadable (${(e as Error).message}); moved to ${aside}. All flags start idle: check any rollout that was in progress.`);
      return {};
    }
  }

  save(flags: Record<string, FlagRuntime>): void {
    const f = join(this.dir, 'state.json');
    writeFileSync(f + '.tmp', JSON.stringify(flags, null, 2));
    renameSync(f + '.tmp', f);
  }

  append(event: GuardianEvent): void {
    this.events.push(event);
    if (this.events.length > 500) this.events.shift();
    appendFileSync(join(this.dir, 'events.jsonl'), JSON.stringify(event) + '\n');
  }

  recent(limit = 100): GuardianEvent[] {
    return this.events.slice(-limit);
  }
}

/** In-memory store for tests. */
export class MemoryStore implements Store {
  flags: Record<string, FlagRuntime> = {};
  events: GuardianEvent[] = [];
  load() { return structuredClone(this.flags); }
  save(flags: Record<string, FlagRuntime>) { this.flags = structuredClone(flags); }
  append(e: GuardianEvent) { this.events.push(e); }
  recent(limit = 100) { return this.events.slice(-limit); }
}
