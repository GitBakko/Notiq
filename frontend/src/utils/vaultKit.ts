// Kit di recupero vault v3: S_user (20 B) -> 32 simboli Crockford + 2 simboli di controllo.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const KIT_BYTES = 20;
const KIT_SYMBOLS = 32;

function checkValue(values: number[]): number {
  let c = 0;
  for (let i = 0; i < KIT_SYMBOLS; i++) c += (i + 1) * values[i];
  return c % 1021;
}

/** 34 simboli senza separatori: 32 di dati + 2 di controllo. */
export function encodeKit(bytes: Uint8Array): string {
  if (bytes.length !== KIT_BYTES) throw new Error('vault.kit.errors.invalidLength');
  const values: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      values.push((acc >> bits) & 31);
    }
    acc &= (1 << bits) - 1;
  }
  const c = checkValue(values);
  values.push(c >> 5, c & 31);
  return values.map((v) => ALPHABET[v]).join('');
}

/** `XXXX-XXXX-...-XXXX  CC` */
export function formatKit(bytes: Uint8Array): string {
  const s = encodeKit(bytes);
  const groups: string[] = [];
  for (let i = 0; i < KIT_SYMBOLS; i += 4) groups.push(s.slice(i, i + 4));
  return `${groups.join('-')}  ${s.slice(KIT_SYMBOLS)}`;
}

/** Maiuscolo, via `-` e spazi, O->0, I/L->1. */
export function normalizeKit(input: string): string {
  return input.toUpperCase().replace(/[-\s]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

/** Errori: `vault.kit.errors.invalidLength`, `...invalidChar`, `...checksum` (chiavi i18n). */
export function parseKit(input: string): Uint8Array {
  const s = normalizeKit(input);
  if (s.length !== KIT_SYMBOLS + 2) throw new Error('vault.kit.errors.invalidLength');
  const values: number[] = [];
  for (const ch of s) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error('vault.kit.errors.invalidChar');
    values.push(v);
  }
  if (checkValue(values) !== values[KIT_SYMBOLS] * 32 + values[KIT_SYMBOLS + 1]) {
    throw new Error('vault.kit.errors.checksum');
  }
  const out = new Uint8Array(KIT_BYTES);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < KIT_SYMBOLS; i++) {
    acc = (acc << 5) | values[i];
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 255;
      acc &= (1 << bits) - 1;
    }
  }
  return out;
}
