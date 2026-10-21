import { describe, it, expect } from 'vitest';
import { encodeKit, formatKit, normalizeKit, parseKit } from '../vaultKit';
import { buildKitPdf } from '../kitPdf';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const sample = Uint8Array.from({ length: 20 }, (_, i) => (i * 37 + 11) & 255);

describe('vaultKit', () => {
  it('roundtrip e lunghezza 32+2', () => {
    const s = encodeKit(sample);
    expect(s).toHaveLength(34);
    expect(parseKit(s)).toEqual(sample);
    for (let k = 0; k < 50; k++) {
      const b = crypto.getRandomValues(new Uint8Array(20));
      expect(parseKit(formatKit(b))).toEqual(b);
    }
  });

  it('formato XXXX-...-XXXX  CC', () => {
    expect(formatKit(sample)).toMatch(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4} {2}[0-9A-Z]{2}$/);
  });

  it('tutte le 32x31 sostituzioni singole sono rilevate', () => {
    const s = encodeKit(sample);
    let n = 0;
    for (let i = 0; i < 32; i++) {
      for (const ch of ALPHABET) {
        if (ch === s[i]) continue;
        n++;
        expect(() => parseKit(s.slice(0, i) + ch + s.slice(i + 1))).toThrow('vault.kit.errors.checksum');
      }
    }
    expect(n).toBe(32 * 31);
  });

  // 32 simboli da 5 bit = 160 bit = 20 byte esatti.
  const symbolsToBytes = (v: number[]) => {
    const out = new Uint8Array(20);
    let acc = 0;
    let bits = 0;
    let o = 0;
    for (const x of v) {
      acc = (acc << 5) | x;
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        out[o++] = (acc >> bits) & 255;
        acc &= (1 << bits) - 1;
      }
    }
    return out;
  };

  it('scambi adiacenti rilevati: ogni posizione 0..30, ogni coppia di valori diversi', () => {
    let n = 0;
    for (let i = 0; i < 31; i++) {
      for (let a = 0; a < 32; a++) {
        for (let b = 0; b < 32; b++) {
          if (a === b) continue;
          const v = Array.from({ length: 32 }, (_, k) => (k * 7 + 3) % 32);
          v[i] = a;
          v[i + 1] = b;
          const s = encodeKit(symbolsToBytes(v));
          expect(parseKit(s)).toEqual(symbolsToBytes(v));
          n++;
          expect(() => parseKit(s.slice(0, i) + s[i + 1] + s[i] + s.slice(i + 2))).toThrow('vault.kit.errors.checksum');
        }
      }
    }
    expect(n).toBe(31 * 32 * 31);
  }, 60000);

  it('sostituzione di ciascuno dei 2 simboli di controllo e ZZ (c=1023) sono rilevati', () => {
    const s = encodeKit(sample);
    for (const i of [32, 33]) {
      for (const ch of ALPHABET) {
        if (ch === s[i]) continue;
        expect(() => parseKit(s.slice(0, i) + ch + s.slice(i + 1))).toThrow('vault.kit.errors.checksum');
      }
    }
    expect(() => parseKit(s.slice(0, 32) + 'ZZ')).toThrow('vault.kit.errors.checksum');
  });

  it('normalizza input', () => {
    const grouped = formatKit(sample).toLowerCase();
    expect(parseKit(grouped)).toEqual(sample);
    expect(normalizeKit('o-I l')).toBe('011');
  });

  it('U e altri caratteri sono errore', () => {
    const s = encodeKit(sample);
    expect(() => parseKit('U' + s.slice(1))).toThrow('vault.kit.errors.invalidChar');
    expect(() => parseKit('!' + s.slice(1))).toThrow('vault.kit.errors.invalidChar');
    expect(() => parseKit(s.slice(1))).toThrow('vault.kit.errors.invalidLength');
    expect(() => encodeKit(new Uint8Array(19))).toThrow();
  });
});

describe('kitPdf', () => {
  it('PDF 1.4 di 1 pagina con xref coerente', () => {
    const bytes = buildKitPdf({ title: 'Kit (test)', lines: ['riga \\ uno', 'caffè'], kit: formatKit(sample), footer: 'f' });
    const txt = String.fromCharCode(...bytes);
    expect(txt.startsWith('%PDF-1.4\n')).toBe(true);
    expect(txt.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(txt).toContain('/Count 1');
    expect(txt).toContain(formatKit(sample));
    const startxref = Number(/startxref\n(\d+)/.exec(txt)![1]);
    expect(txt.slice(startxref, startxref + 4)).toBe('xref');
    const offs = [...txt.matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]));
    expect(offs).toHaveLength(6);
    offs.forEach((o, i) => expect(txt.slice(o, o + 7)).toBe(`${i + 1} 0 obj`));
    const len = Number(/\/Length (\d+)/.exec(txt)![1]);
    const start = txt.indexOf('stream\n') + 7;
    expect(txt.slice(start + len, start + len + 9)).toBe('endstream');
  });

  const pdfText = (o: Parameters<typeof buildKitPdf>[0]) => String.fromCharCode(...buildKitPdf(o));
  const base = { title: 't', kit: 'K', lines: [] as string[] };

  it('a capo a 85 caratteri sugli spazi', () => {
    const words = Array.from({ length: 40 }, () => 'abcdefgh'); // 40*9-1 = 359 car.
    const txt = pdfText({ ...base, lines: [words.join(' ')] });
    const rows = [...txt.matchAll(/Td \(([^)]*)\) Tj/g)].map((m) => m[1]).slice(1, -1);
    expect(rows.length).toBeGreaterThan(1);
    rows.forEach((r) => expect(r.length).toBeLessThanOrEqual(85));
    expect(rows.join(' ')).toBe(words.join(' '));
    // parola unica piu' lunga di 85: spezzata
    const long = pdfText({ ...base, lines: ['x'.repeat(200)] });
    expect(long).toContain('x'.repeat(85));
    expect(long).not.toContain('x'.repeat(86));
  });

  it('lancia se il Kit scenderebbe sotto y=60', () => {
    // y parte da 780-40=740; con n righe: 740-16n-20 < 60  =>  n >= 42
    expect(() => buildKitPdf({ ...base, lines: Array(41).fill('r') })).not.toThrow();
    expect(() => buildKitPdf({ ...base, lines: Array(42).fill('r') })).toThrow();
  });

  it('escaping, Latin-1 e "?" per il resto', () => {
    const bytes = buildKitPdf({ ...base, lines: ['a(b)c\\d \u00e9 \u20ac \u007f \u0085'] });
    const txt = String.fromCharCode(...bytes);
    expect(txt).toContain('(a\\(b\\)c\\\\d \u00e9 ? ? ?)');
    expect(bytes).toContain(0xe9);
  });
});
