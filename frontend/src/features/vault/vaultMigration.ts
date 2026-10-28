import { db } from '../../lib/db';
import { purgeApiCache } from '../../lib/apiCache';
import { finalizeItems, getItems, migrateItems, type MigrateItem } from '../../lib/vaultApi';
import { decryptItem, encryptItem, type VaultCodecCtx, type VaultNoteType } from '../../lib/vaultCodec';
import { vaultReconcile, type ReconcileResult, type ServerItem } from '../../lib/vaultReconcile';
import { useVaultStore } from '../../store/vaultStore';
import { decryptContent } from '../../utils/crypto';
import { ENVELOPE_RE, sha256hex } from '../../utils/vaultCrypto';
import { syncPush } from '../sync/syncService';
import { EMPTY_CREDENTIAL } from './credentialTypes';

// Migrazione dei vault legacy (piano P2 §6), logica senza UI. Sorgente = server (POST /vault/items, mai GET /notes ne' Dexie): titolo da item.title.
// Il plaintext (t, c, PIN vecchi) vive solo nelle variabili di queste funzioni: mai in Dexie, coda, storage o log. Prima di ogni invio la cifratura
// e' riletta in memoria; finalize parte solo sugli id i cui byte DEL SERVER, riletti e decifrati, coincidono con l'originale.

export const MIGRATE_BATCH_ITEMS = 200; // max del server (migrateSchema)
export const MIGRATE_BATCH_BYTES = 12 * 1024 * 1024;
export const MAX_ENVELOPE_LEN = 2 * 1024 * 1024; // oltre non passa il limite del server: item lasciato com'e'
const ITEM_OVERHEAD = 256; // id + baseHash + noteType + JSON: ASCII, quindi 1 char = 1 byte
const IDS_CHUNK = 200;
const WORKER_TIMEOUT_MS = 60_000; // un decrypt legacy dura ~2 s
const FINALIZE_CHUNK = 500;
const MAX_ROUNDS = 3;

export type MigrationErrorCode = 'flushTimeout' | 'locked' | 'invalid' | 'aborted' | 'busy' | 'notReady';
export class MigrationError extends Error {
  code: MigrationErrorCode;
  constructor(code: MigrationErrorCode) {
    super(`vault.migrate.${code}`);
    this.name = 'MigrationError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Classificazione (pura) e PIN vecchi
// ---------------------------------------------------------------------------------------------------------------------

const CRED_KEYS = ['siteUrl', 'username', 'password', 'notes'];
const parseObject = (s: string): Record<string, unknown> | null => {
  try {
    const o: unknown = JSON.parse(s);
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};
/** Un PIN e' valido se il testo decifrato e' un oggetto con le chiavi di CredentialData (una decifratura con PIN errato puo' dare spazzatura UTF-8). */
const isCredentialJson = (s: string) => {
  const o = parseObject(s);
  return !!o && CRED_KEYS.some((k) => k in o);
};

export type Classified = { kind: 'ready'; t: string; c: string } | { kind: 'locked' };

/** NOTE: content byte per byte. CREDENTIAL: '' -> credenziale vuota, JSON in chiaro -> tale e quale, v2:/CryptoJS -> serve un vecchio PIN. */
export function classify(item: ServerItem): Classified {
  if (item.noteType === 'NOTE') return { kind: 'ready', t: item.title, c: item.content };
  if (item.content === '') return { kind: 'ready', t: item.title, c: JSON.stringify(EMPTY_CREDENTIAL) };
  if (parseObject(item.content)) return { kind: 'ready', t: item.title, c: item.content };
  return { kind: 'locked' };
}

export interface LegacyDecryptor {
  /** Quanti decrypt possono girare in parallelo. */
  size: number;
  decrypt: (content: string, pin: string) => Promise<string | null>;
  terminate: () => void;
}

/** Pool di Worker per il PBKDF2 legacy (~2 s a tentativo, un sale per item). Senza Worker (test, ambienti vecchi) gira inline. */
export function createLegacyDecryptor(): LegacyDecryptor {
  if (typeof Worker === 'undefined') return { size: 1, decrypt: async (c, p) => decryptContent(c, p), terminate: () => {} };
  const size = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
  type Waiter = { w: Worker; resolve: (v: string | null) => void; reject: (e: Error) => void };
  let pool: Worker[] = [];
  const waiting = new Map<number, Waiter>();
  let nextId = 1;
  let rr = 0;
  let closed = false;
  const drop = (w: Worker) => {
    w.terminate();
    pool = pool.filter((x) => x !== w);
    for (const [id, p] of waiting) {
      if (p.w !== w) continue;
      waiting.delete(id);
      p.reject(new Error('legacyWorkerFailed'));
    }
  };
  const spawn = () => {
    const w = new Worker(new URL('./legacyDecrypt.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<{ id: number; plain: string | null }>) => {
      const p = waiting.get(e.data.id);
      if (!p) return;
      waiting.delete(e.data.id);
      p.resolve(e.data.plain ?? null);
    };
    w.onerror = () => drop(w);
    return w;
  };
  return {
    size,
    decrypt: (content, pin) => {
      if (closed) return Promise.reject(new Error('legacyWorkerFailed')); // dopo terminate() niente Worker orfani
      if (pool.length < size && waiting.size >= pool.length) pool.push(spawn());
      const w = pool[rr++ % pool.length];
      return new Promise((resolve, reject) => {
        const id = nextId++;
        // Worker morto senza evento `error` (OOM): il messaggio non resterebbe sospeso per sempre
        const timer = setTimeout(() => drop(w), WORKER_TIMEOUT_MS);
        waiting.set(id, { w, resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
        w.postMessage({ id, content, pin });
      });
    },
    terminate: () => { closed = true; [...pool].forEach(drop); },
  };
}

/** Prova i PIN (prima l'ultimo riuscito: di solito una credenziale su due ha lo stesso). Restituisce `c` = JSON.stringify(oggetto), o null. */
export function makeLegacyUnlocker(pins: string[], dec: LegacyDecryptor) {
  let lastGood: string | null = null;
  return async (content: string): Promise<string | null> => {
    const order = lastGood && pins.includes(lastGood) ? [lastGood, ...pins.filter((p) => p !== lastGood)] : pins;
    for (const pin of order) {
      const plain = await dec.decrypt(content, pin);
      if (plain == null || !isCredentialJson(plain)) continue;
      lastGood = pin;
      return JSON.stringify(JSON.parse(plain));
    }
    return null;
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Passo 0: flush della coda
// ---------------------------------------------------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Item di coda NOTE dell'utente su note vault non ancora partiti. I `failed` non contano (non si risolvono aspettando). */
async function countPendingVaultItems(userId: string): Promise<number> {
  const items = await db.syncQueue.filter((i) => i.entity === 'NOTE' && i.userId === userId && i.status !== 'failed').toArray();
  let n = 0;
  for (const i of items) {
    if (i.data?.isVault === true || (await db.notes.get(i.entityId))?.isVault) n++;
  }
  return n;
}

/** Passo 0: `syncPush()` e attesa di zero item pending sulle note vault (30 s al massimo, poi 'flushTimeout' = "riprova"). */
export async function flushPending(userId: string, o: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {}): Promise<void> {
  const deadline = Date.now() + (o.timeoutMs ?? 30_000);
  const pollMs = o.pollMs ?? 500;
  let running = true;
  let kickedAt = 0;
  const kick = () => {
    running = true;
    kickedAt = Date.now();
    syncPush().catch(() => false).finally(() => { running = false; });
  };
  kick();
  for (;;) {
    if (o.signal?.aborted) throw new MigrationError('aborted');
    if ((await countPendingVaultItems(userId)) === 0) return;
    if (Date.now() >= deadline) throw new MigrationError('flushTimeout');
    await sleep(pollMs);
    // push finito ma item ancora pending (backoff, rete): riparte, non piu' di una volta ogni 2 s
    if (!running && Date.now() - kickedAt >= 2000) kick();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Passi 2-6: lettura dal server, cifratura, /migrate, verifica, /finalize
// ---------------------------------------------------------------------------------------------------------------------

interface ItemsPage { items: ServerItem[]; next: string | null }
const isLegacyContent = (i: ServerItem) => !i.content.startsWith('nv3.');

/** Tutte le pagine di /items, solo gli item col content non envelope. Nessun GET /notes. */
async function listLegacy(): Promise<ServerItem[]> {
  const out: ServerItem[] = [];
  let after: string | undefined;
  do {
    const page = await getItems<ItemsPage>(after ? { after } : {});
    out.push(...page.items.filter(isLegacyContent));
    after = page.next ?? undefined;
  } while (after);
  return out;
}

async function fetchByIds(ids: string[]): Promise<ServerItem[]> {
  const out: ServerItem[] = [];
  for (let i = 0; i < ids.length; i += IDS_CHUNK) out.push(...(await getItems<ItemsPage>({ ids: ids.slice(i, i + IDS_CHUNK) })).items);
  return out;
}

export interface MigrationProgress { done: number; total: number }

export interface MigrationOptions {
  /** Chiavi dell'utente sbloccato, epoch READY. */
  ctx: VaultCodecCtx;
  /** Vecchi PIN (credenziali v2/legacy), in memoria per la sola sessione di migrazione. */
  pins: string[];
  signal?: AbortSignal;
  onProgress?: (p: MigrationProgress) => void;
  /** Condiviso con closeMigration; se assente se ne crea uno e lo si termina a fine funzione. */
  decryptor?: LegacyDecryptor;
}

export interface MigrationResult {
  /** Migrati, verificati dai byte del server e finalizzati. */
  migrated: number;
  /** Credenziali v2/legacy che nessun PIN apre: restano byte-identiche sul server. */
  locked: string[];
  /** Envelope oltre 2 MiB: restano in chiaro (apribili in sola lettura). */
  tooLarge: string[];
  /** Ancora in conflitto dopo 3 giri (un altro dispositivo li modifica). */
  conflicts: string[];
  /** Migrati ma non verificati (un altro dispositivo li ha cambiati) o rifiutati da finalize: li riprende il reconcile. */
  unverified: string[];
  /** Cifratura o round-trip fallito in memoria: non inviati. */
  failed: string[];
  notFound: number;
  /** Item della coda legacy con allegati (gli allegati non sono cifrati né mostrati nel vault). */
  withAttachments: number;
}

interface Prepared { id: string; noteType: VaultNoteType; t: string; c: string; env: string; baseHash: string; size: number }

/** Impacchetta nell'ordine: al massimo 200 item e 12 MiB per batch. */
export function packBatches<T extends { size: number }>(items: T[]): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let bytes = 0;
  for (const it of items) {
    if (cur.length > 0 && (cur.length >= MIGRATE_BATCH_ITEMS || bytes + it.size > MIGRATE_BATCH_BYTES)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(it);
    bytes += it.size;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

export async function migrateLegacy(opts: MigrationOptions): Promise<MigrationResult> {
  const { ctx, pins, signal } = opts;
  const dec = opts.decryptor ?? createLegacyDecryptor();
  const unlock = makeLegacyUnlocker(pins, dec);
  const res: MigrationResult = { migrated: 0, locked: [], tooLarge: [], conflicts: [], unverified: [], failed: [], notFound: 0, withAttachments: 0 };
  const settled = new Set<string>();
  let total = 0;
  const tick = (id: string) => {
    settled.add(id);
    opts.onProgress?.({ done: settled.size, total });
  };
  const check = () => {
    if (signal?.aborted) throw new MigrationError('aborted');
    if (useVaultStore.getState().keys !== ctx.keys) throw new MigrationError('locked'); // lock durante il giro
  };

  const prepare = async (item: ServerItem): Promise<Prepared | null> => {
    try {
      const c0 = classify(item);
      let t = item.title;
      let c: string;
      if (c0.kind === 'locked') {
        const unlocked = await unlock(item.content); // se un Worker muore rifiuta: l'item finisce in `failed`, gli altri proseguono
        if (unlocked == null) { res.locked.push(item.id); tick(item.id); return null; }
        c = unlocked;
      } else {
        t = c0.t;
        c = c0.c;
      }
      const env = await encryptItem(item.id, item.noteType, { t, c }, ctx);
      if (env.length > MAX_ENVELOPE_LEN) { res.tooLarge.push(item.id); tick(item.id); return null; }
      const back = await decryptItem(item.id, item.noteType, env, ctx);
      if (back.t !== t || back.c !== c) throw new Error('roundTrip');
      return { id: item.id, noteType: item.noteType, t, c, env, baseHash: await sha256hex(item.content), size: env.length + ITEM_OVERHEAD };
    } catch {
      res.failed.push(item.id);
      tick(item.id);
      return null;
    }
  };

  /** Passo 6: byte del server riletti, decifrati e confrontati in modo esatto con l'originale; solo i verificati vanno a finalize. */
  const verifyAndFinalize = async (sent: Prepared[]) => {
    const byId = new Map(sent.map((p) => [p.id, p]));
    const verified: string[] = [];
    for (const it of await fetchByIds(sent.map((p) => p.id))) {
      const p = byId.get(it.id);
      if (!p) continue;
      byId.delete(it.id);
      let same = false;
      if (ENVELOPE_RE.test(it.content)) {
        try {
          const d = await decryptItem(it.id, p.noteType, it.content, ctx);
          same = d.t === p.t && d.c === p.c;
        } catch { /* non decifrabile: non verificato */ }
      }
      if (same) verified.push(it.id);
      else res.unverified.push(it.id);
    }
    for (const id of byId.keys()) res.unverified.push(id); // spariti dal listing del server
    for (let i = 0; i < verified.length; i += FINALIZE_CHUNK) {
      const chunk = verified.slice(i, i + FINALIZE_CHUNK);
      const f = await finalizeItems<{ finalized: number; rejected: string[] }>(chunk);
      const rejected = new Set(f.rejected);
      res.migrated += chunk.length - rejected.size;
      res.unverified.push(...rejected);
    }
    sent.forEach((p) => tick(p.id));
  };

  try {
    let queue = await listLegacy();
    res.withAttachments = queue.filter((i) => (i as { hasAttachments?: boolean }).hasAttachments).length;
    total = queue.length;
    opts.onProgress?.({ done: 0, total });
    for (let round = 1; queue.length > 0; round++) {
      if (round > MAX_ROUNDS) { res.conflicts = queue.map((i) => i.id); break; }
      const conflicted: string[] = [];
      const sendBatch = async (batch: Prepared[]) => {
        check();
        const body: MigrateItem[] = batch.map((p) => ({ id: p.id, baseHash: p.baseHash, content: p.env, noteType: p.noteType }));
        const { results } = await migrateItems<{ results: { id: string; status: string }[] }>(body);
        const ok: Prepared[] = [];
        const byId = new Map(batch.map((p) => [p.id, p]));
        for (const r of results) {
          const p = byId.get(r.id);
          if (!p) continue;
          if (r.status === 'ok' || r.status === 'already') ok.push(p);
          else if (r.status === 'conflict') conflicted.push(p.id);
          else if (r.status === 'notFound') { res.notFound++; tick(p.id); }
          else throw new MigrationError('invalid'); // 'invalid' = bug o epoch diverso: ci si ferma, niente finalize
        }
        if (ok.length > 0) await verifyAndFinalize(ok);
      };
      // Streaming: si invia ogni batch chiuso (200 item / 12 MiB) e si scartano i Prepared inviati, senza tenere l'intero vault in memoria.
      let pending: Prepared[] = [];
      for (let i = 0; i < queue.length; i += dec.size) {
        check();
        pending.push(...(await Promise.all(queue.slice(i, i + dec.size).map(prepare))).filter((p): p is Prepared => p !== null));
        const batches = packBatches(pending);
        pending = batches.pop() ?? [];
        for (const b of batches) await sendBatch(b);
      }
      if (pending.length > 0) await sendBatch(pending);
      queue = conflicted.length > 0 ? (await fetchByIds(conflicted)).filter(isLegacyContent) : [];
    }
  } finally {
    if (!opts.decryptor) dec.terminate();
  }
  return res;
}

// ---------------------------------------------------------------------------------------------------------------------
// Passo 7: chiusura
// ---------------------------------------------------------------------------------------------------------------------

/** Passo 7b-c: `vaultReconcile` con i vecchi PIN (righe e item legacy della coda), poi `clearLegacy()` e `purgeApiCache()`.
 *  `skipped:'busy'` = attesa del lock interrotta dal signal ("riprova"): non si pulisce nulla. Lo stesso vale per 'locked'/'notReady'. */
export async function closeMigration(o: { pins: string[]; signal?: AbortSignal; decryptor?: LegacyDecryptor }): Promise<ReconcileResult> {
  const dec = o.decryptor ?? createLegacyDecryptor();
  const unlock = makeLegacyUnlocker(o.pins, dec);
  try {
    const r = await vaultReconcile({
      // il PBKDF2 legacy puo' durare minuti senza input: l'auto-lock non deve scattare a meta' giro
      decryptLegacy: (row) => { useVaultStore.getState().touchVault(); return unlock(row.content); },
      signal: o.signal,
    });
    if (!r.skipped && !r.aborted) {
      useVaultStore.getState().clearLegacy();
      await purgeApiCache();
    }
    return r;
  } finally {
    // B.2: searchText in chiaro lasciato in Dexie dalle note prima del loro ingresso nel vault
    await db.notes.filter((n) => !!n.isVault && !!n.searchText).modify({ searchText: '' }).catch((e) => console.error('[vault] pulizia searchText fallita', e));
    if (!o.decryptor) dec.terminate();
  }
}
