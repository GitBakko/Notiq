import { describe, it, expect } from 'vitest';
import { formatBytes } from '../format';

describe('formatBytes', () => {
  it('returns "0 B" for 0 bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('formats values in the bytes range', () => {
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(100)).toBe('100 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('formats values in the KB range', () => {
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(10240)).toBe('10 KB');
    expect(formatBytes(512000)).toBe('500 KB');
  });

  it('formats values in the MB range', () => {
    expect(formatBytes(1048576)).toBe('1 MB');
    expect(formatBytes(5242880)).toBe('5 MB');
    expect(formatBytes(1572864)).toBe('1.5 MB');
  });

  it('formats values in the GB range', () => {
    expect(formatBytes(1073741824)).toBe('1 GB');
    expect(formatBytes(2147483648)).toBe('2 GB');
    expect(formatBytes(1610612736)).toBe('1.5 GB');
  });

  it('formats values in the TB range', () => {
    expect(formatBytes(1099511627776)).toBe('1 TB');
  });

  it('rounds to at most 2 decimal places', () => {
    // 1024 + 100 = 1124 bytes = 1.09765625 KB -> rounds to 1.1 KB
    expect(formatBytes(1124)).toBe('1.1 KB');
    // 1024 + 10 = 1034 bytes = 1.009765625 KB -> rounds to 1.01 KB
    expect(formatBytes(1034)).toBe('1.01 KB');
  });

  it('drops trailing zeros after decimal point', () => {
    // 2048 bytes = exactly 2 KB, not "2.00 KB"
    expect(formatBytes(2048)).toBe('2 KB');
    // 1536 bytes = 1.5 KB, not "1.50 KB"
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  it('handles exact power-of-1024 boundaries', () => {
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1024 * 1024)).toBe('1 MB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB');
    expect(formatBytes(1024 * 1024 * 1024 * 1024)).toBe('1 TB');
  });

  it('handles small positive values', () => {
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(500)).toBe('500 B');
  });
});
