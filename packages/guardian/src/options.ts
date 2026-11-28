/**
 * Validation for `guardian run` options. Kept out of cli.ts (which parses argv on import)
 * so it can be unit-tested.
 */

/** True when a listen address (--host / GUARDIAN_HOST) only accepts connections from this machine. */
export const isLoopbackListen = (host: string): boolean =>
  host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);

/**
 * Upper bound for --tick. setTimeout treats delays above 2^31-1 ms (~24.8 days) as 1 ms,
 * which would turn a huge value into a tight loop; one day is far beyond any sane tick.
 */
const MAX_TICK_SECONDS = 86_400;

/** `--tick` / GUARDIAN_TICK_SECONDS → seconds. Below 1 s Guardian would hammer Flagsmith and Prometheus. */
export function parseTickSeconds(value: string): number {
  const n = Number(value);
  if (value.trim() === '' || !Number.isFinite(n) || n < 1 || n > MAX_TICK_SECONDS) {
    throw new Error(`--tick must be a number of seconds between 1 and ${MAX_TICK_SECONDS} (got "${value}")`);
  }
  return n;
}

/** `--port` / PORT → TCP port (0 = pick a free one). */
export function parsePort(value: string): number {
  const n = Number(value);
  if (value.trim() === '' || !Number.isInteger(n) || n < 0 || n > 65_535) {
    throw new Error(`--port must be a whole number between 0 and 65535 (got "${value}")`);
  }
  return n;
}
