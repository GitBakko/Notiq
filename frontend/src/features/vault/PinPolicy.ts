// Policy del PIN vault (piano P2 sezione 3). Case-sensitive: il PIN e' lungo 6, con almeno una lettera e una cifra.
// Le regole di contenuto girano sul minuscolo. La blocklist e' in un chunk separato (import() lazy).

export type PinRejection =
  | 'format'
  | 'date'
  | 'sequence'
  | 'repetition'
  | 'common'
  | 'personal';

export type PinCheck = { ok: true } | { ok: false; reason: PinRejection };

export interface PinContext {
  name?: string | null;
  surname?: string | null;
  email?: string | null;
}

const FORMAT = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9]{6}$/;
const KEY_ROWS = [
  'qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890',
  '1qaz', '2wsx', '3edc', '4rfv', '5tgb', '6yhn', '7ujm', '8ik', '9ol', // colonne
];

const isRun = (s: string, step: number) => {
  for (let i = 1; i < s.length; i++) if (s.charCodeAt(i) - s.charCodeAt(i - 1) !== step) return false;
  return true;
};

function hasDate(p: string): boolean {
  if (/19\d\d|20\d\d/.test(p)) return true;
  for (let i = 0; i + 4 <= p.length; i++) {
    const w = p.slice(i, i + 4);
    if (!/^\d{4}$/.test(w)) continue;
    const a = Number(w.slice(0, 2));
    const b = Number(w.slice(2));
    if (a >= 1 && a <= 31 && b >= 1 && b <= 12) return true; // ddmm
    if (a >= 1 && a <= 12) return true; // mmyy (yy qualsiasi)
  }
  return false;
}

function hasSequence(p: string): boolean {
  for (let i = 0; i + 3 <= p.length; i++) {
    const w = p.slice(i, i + 3);
    if (isRun(w, 1) || isRun(w, -1)) return true;
    const r = [...w].reverse().join('');
    if (KEY_ROWS.some((row) => row.includes(w) || row.includes(r))) return true;
  }
  return false;
}

// Passo 0 o +-1 fra caratteri consecutivi di una serie.
// Conta anche una sottostringa contigua di una riga/colonna di tastiera (1q2w3e, a1s2d3).
const slowSeries = (s: string) =>
  s.length < 2 || isRun(s, 0) || isRun(s, 1) || isRun(s, -1) ||
  KEY_ROWS.some((r) => r.includes(s) || r.includes([...s].reverse().join('')));

function hasRepetition(p: string): boolean {
  if (/(.)(.*\1){2}/.test(p)) return true; // stesso carattere 3+ volte, ovunque
  if (p.slice(0, 3) === p.slice(3) || /^(..)\1\1$/.test(p)) return true; // abcabc, ababab
  if (/(..).*\1/.test(p) || new Set(p).size <= 3) return true; // ab12ab, aabb11
  const even =[...p].filter((_, i) => i % 2 === 0).join('');
  const odd = [...p].filter((_, i) => i % 2 === 1).join('');
  return slowSeries(even) && slowSeries(odd); // a1a1a1, a1b2c3
}

async function isCommonWord(p: string): Promise<boolean> {
  const runs = [...p.matchAll(/[a-z]{4,}/g)].map((m) => m[0]);
  if (!runs.length) return false;
  const { PIN_BLOCKLIST } = await import('./pinBlocklist');
  for (const run of runs)
    for (const n of [4, 5])
      for (let i = 0; i + n <= run.length; i++) if (PIN_BLOCKLIST.has(run.slice(i, i + n))) return true;
  return false;
}

function hasPersonal(p: string, ctx: PinContext): boolean {
  const parts = [ctx.name, ctx.surname, ctx.email?.split('@')[0]]
    .map((s) => (s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, ''))
    .filter((s) => s.length >= 3);
  if (parts.some((s) => s.length === 3 && p.includes(s))) return true;
  for (let i = 0; i + 4 <= p.length; i++) {
    const w = p.slice(i, i + 4);
    if (parts.some((s) => s.length >= 4 && s.includes(w))) return true;
  }
  return false;
}

export async function checkPin(pin: string, ctx: PinContext = {}): Promise<PinCheck> {
  if (!FORMAT.test(pin)) return { ok: false, reason: 'format' };
  const p = pin.toLowerCase();
  if (hasSequence(p)) return { ok: false, reason: 'sequence' };
  if (hasDate(p)) return { ok: false, reason: 'date' };
  if (hasRepetition(p)) return { ok: false, reason: 'repetition' };
  if (hasPersonal(p, ctx)) return { ok: false, reason: 'personal' };
  if (await isCommonWord(p)) return { ok: false, reason: 'common' };
  return { ok: true };
}
