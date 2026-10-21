import { describe, it, expect } from 'vitest';
import { checkPin, type PinRejection } from '../PinPolicy';
import policySource from '../PinPolicy.ts?raw';

const rejected: [string, PinRejection][] = [
  ['123456', 'format'], ['abcdef', 'format'], ['k7Rq2', 'format'], ['k7Rq2xZ', 'format'],
  ['2024ab', 'date'], ['1203ab', 'date'],
  ['qwer12', 'sequence'], ['abc7x9', 'sequence'], ['1qaz9x', 'sequence'], ['x7qazk', 'sequence'], ['zaq1x7', 'sequence'], ['x3edcv', 'sequence'], ['k9olm7', 'sequence'],
  ['a1a1a1', 'repetition'], ['a1b2c3', 'repetition'], ['k7k9k2', 'repetition'], ['Ab1Ab1', 'repetition'], ['Qq1Qq1', 'repetition'], ['kz7kz7', 'repetition'], ['x9x9x9', 'repetition'],
  ['1q2w3e', 'repetition'], ['a1s2d3', 'repetition'], ['ab12ab', 'repetition'], ['aabb11', 'repetition'],
  ['luca1x', 'common'], ['xluca1', 'common'],
  ['Marco1', 'common'], ['luca99', 'common'], ['Matte1', 'common'], ['Stefa1', 'common'], ['Giova1', 'common'],
];

describe('PinPolicy', () => {
  it.each(rejected)('rifiuta %s (%s)', async (pin, reason) => {
    expect(await checkPin(pin)).toEqual({ ok: false, reason });
  });

  it('accetta k7Rq2x', async () => {
    expect(await checkPin('k7Rq2x')).toEqual({ ok: true });
  });

  it('rifiuta sottostringhe di 4+ caratteri di nome, cognome, email', async () => {
    const ctx = { name: 'Stefano', surname: 'Brunelli', email: 'bakko.posta@gmail.com' };
    expect(await checkPin('xstef7', ctx)).toEqual({ ok: false, reason: 'personal' });
    expect(await checkPin('7runel', ctx)).toEqual({ ok: false, reason: 'personal' });
    expect(await checkPin('Bakk7x', ctx)).toEqual({ ok: false, reason: 'personal' });
    expect((await checkPin('k7Rq2x', ctx)).ok).toBe(true);
  });

  it('rifiuta parti di 3 caratteri', async () => {
    expect(await checkPin('Leo7k2', { name: 'Leo' })).toEqual({ ok: false, reason: 'personal' });
    expect((await checkPin('k7Rq2x', { name: 'Leo', surname: 'Rossi', email: 'leo@x.it' })).ok).toBe(true);
  });

  it('normalizza i diacritici di nome/cognome', async () => {
    expect(await checkPin('icolo1', { name: 'Nicolò' })).toEqual({ ok: false, reason: 'personal' });
  });

  it('blocklist: ogni parola grezza di 4+ lettere ha il prefisso di 4 o 5 lettere', async () => {
    const { PIN_BLOCKLIST, PIN_RAW_WORDS } = await import('../pinBlocklist');
    for (const w of PIN_RAW_WORDS) {
      expect(PIN_BLOCKLIST.has(w.slice(0, 5)) || PIN_BLOCKLIST.has(w.slice(0, 4))).toBe(true);
    }
  });

  it('chunk: blocklist solo con import() dinamico', () => {
    expect(policySource).not.toMatch(/^\s*import[^(\n]*from\s+['"]\.\/pinBlocklist/m);
    expect(policySource).toMatch(/import\(['"]\.\/pinBlocklist['"]\)/);
  });

  it('blocklist: 2000+ voci, chunk lazy', async () => {
    const { PIN_BLOCKLIST } = await import('../pinBlocklist');
    expect(PIN_BLOCKLIST.size).toBeGreaterThanOrEqual(2000);
    expect(PIN_BLOCKLIST.size).toBeLessThanOrEqual(5000);
  });
});
