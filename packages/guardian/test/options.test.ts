import { describe, expect, it } from 'vitest';
import { isLoopbackListen, parsePort, parseTickSeconds } from '../src/options.js';

describe('run options', () => {
  it('accepts sane tick values', () => {
    expect(parseTickSeconds('5')).toBe(5);
    expect(parseTickSeconds('1.5')).toBe(1.5);
  });

  it('rejects ticks that would hammer Flagsmith and Prometheus (or overflow setTimeout)', () => {
    for (const v of ['abc', '', ' ', '0', '0.5', '-5', 'NaN', 'Infinity', '1e9']) {
      expect(() => parseTickSeconds(v), v).toThrow(/--tick/);
    }
  });

  it('validates ports', () => {
    expect(parsePort('8787')).toBe(8787);
    for (const v of ['abc', '', '80.5', '-1', '70000']) expect(() => parsePort(v), v).toThrow(/--port/);
  });

  it('recognises loopback listen addresses', () => {
    for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', '::1']) expect(isLoopbackListen(h), h).toBe(true);
    for (const h of ['0.0.0.0', '::', '192.168.1.5', 'guardian']) expect(isLoopbackListen(h), h).toBe(false);
  });
});
