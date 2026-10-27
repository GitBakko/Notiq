const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'Europe/Rome';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toDatetimeLocal } from '../format';

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe('toDatetimeLocal in Europe/Rome', () => {
  beforeAll(() => {
    expect(new Date('2026-07-01T00:00:00Z').getTimezoneOffset()).toBe(-120);
  });

  it.each([
    ['2026-10-23T13:55:00.000Z', '2026-10-23T15:55'],
    ['2026-01-15T12:00:00.000Z', '2026-01-15T13:00'],
    ['2026-10-25T00:30:00.000Z', '2026-10-25T02:30'],
    ['2026-10-25T01:30:00.000Z', '2026-10-25T02:30'],
    ['2026-10-25T02:30:00.000Z', '2026-10-25T03:30'],
    ['2026-03-29T00:30:00.000Z', '2026-03-29T01:30'],
    ['2026-03-29T01:30:00.000Z', '2026-03-29T03:30'],
  ])('%s -> %s', (iso, expected) => {
    expect(toDatetimeLocal(iso)).toBe(expected);
  });
});
