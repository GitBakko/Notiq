import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { Writable } from 'node:stream';
// setup.ts mocks the logger module: load the real one
const { REDACT_PATHS, loggerOptions } = await vi.importActual<typeof import('../utils/logger')>('../utils/logger');

function capture() {
  let out = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      out += chunk.toString();
      cb();
    },
  });
  const log = pino({ redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } }, stream);
  return { log, get out() { return out; } };
}

describe('logger REDACT_PATHS', () => {
  it('redacts nested passphrase', () => {
    const c = capture();
    c.log.info({ body: { passphrase: 'S3cr3t' } }, 'x');
    expect(c.out).not.toContain('S3cr3t');
    expect(c.out).toContain('[REDACTED]');
  });

  it('redacts top-level authKey', () => {
    const c = capture();
    c.log.info({ authKey: 'AAAA' }, 'x');
    expect(c.out).not.toContain('AAAA');
  });

  it('redacts two-level nested codeA', () => {
    const c = capture();
    c.log.info({ a: { b: { codeA: 'X1' } } }, 'x');
    expect(c.out).not.toContain('X1');
  });

  it('shared logger options wire in the redaction', () => {
    expect(loggerOptions.redact.paths).toBe(REDACT_PATHS);
    expect(loggerOptions.redact.censor).toBe('[REDACTED]');
  });

  it('covers all six keys at the three depths', () => {
    for (const k of ['authKey', 'serverShare', 'passphrase', 'pin', 'codeA', 'codeB']) {
      expect(REDACT_PATHS).toEqual(expect.arrayContaining([k, `*.${k}`, `*.*.${k}`]));
    }
    expect(REDACT_PATHS).toHaveLength(18);
  });
});
