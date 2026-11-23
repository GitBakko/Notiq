import i18n from 'i18next';
import { db } from '../../lib/db';
import { purgeApiCache } from '../../lib/apiCache';
import { finalizeItems, getItems, getKeyring, migrateItems, type MigrateItem } from '../../lib/vaultApi';
import { decryptItem, encryptItem, type VaultCodecCtx, type VaultNoteType } from '../../lib/vaultCodec';
import { withReconcileLock } from '../../lib/vaultNoteLock';
import { vaultReconcile, type ReconcileResult, type ServerItem } from '../../lib/vaultReconcile';
import { useVaultStore } from '../../store/vaultStore';
import { decryptContent } from '../../utils/crypto';
import { b64uDecode, ENVELOPE_RE, sha256hex, unwrapPrevVk } from '../../utils/vaultCrypto';
import { syncPush } from '../sync/syncService';
import { EMPTY_CREDENTIAL } from './credentialTypes';

// Migrazione dei vault legacy (piano P2 §6), logica senza UI. Sorgente = server (POST /vault/items, mai GET /notes ne' Dexie): titolo da item.title.
// Il plaintext (t, c, PIN vecchi) vive solo nelle variabili di queste funzioni: mai in Dexie, coda, storage o log. Prima di ogni invio la cifratura
// e' riletta in memoria; finalize parte solo sugli id i cui byte DEL SERVER, riletti e decifrati, coincidono con l'originale.

export const MIGRATE_BATCH_ITEMS = 200; // max del server (migrateSchema)
export const MIGRATE_BATCH_BYTES = 12 * 1024 * 1024;
export const MAX_ENVELOPE_LEN = 2 * 1024 * 1024; // oltre non passa il limite del server: item lasciato com'e'
export const MAX_REWRAP_LEN = 1.5 * 1024 * 1024; // envelope illeggibile piu' lungo: non si re-incapsula (D7), l'utente cancella la nota a mano
const ITEM_OVERHEAD = 256; // id + baseHash + noteType + JSON: ASCII, quindi 1 char = 1 byte
const IDS_CHUNK = 200;
const WORKER_TIMEOUT_MS = 60_000; // un decrypt legacy dura ~2 s
const FINALIZE_CHUNK = 500;
const MAX_ROUNDS = 3;

export type MigrationErrorCode = 'flushTimeout' | 'locked' | 'invalid' | 'aborted' | 'busy' | 'notReady' | 'epochChanged';
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
/** Da portare all'epoch corrente: legacy (non envelope) o envelope di un altro epoch. Il punto finale evita `nv3.1.` / `nv3.10.`. */
const isPending = (i: ServerItem, epoch: number) => !i.content.startsWith(`nv3.${epoch}.`);
/** `only` (envelopes = giro di rotazione, legacy = wizard); senza `only` passa tutto. */
const matchesKind = (i: ServerItem, only?: PendingKind) => !only || i.content.startsWith('nv3.') === (only === 'envelopes');

type PrevState = { kind: 'ok'; ctx: VaultCodecCtx } | { kind: 'absent' } | { kind: 'broken' };
type KeyringInfo = { epoch?: number; prevVkWrap?: string | null };
/** Letture del keyring per giro, una sola ciascuna: `krOf` (epoch e prevVkWrap) e `prevOf` (VK di e-1). */
interface Readers { krOf: () => Promise<KeyringInfo>; prevOf: () => Promise<PrevState>; reread: () => Promise<KeyringInfo> }

/** F: il server e' a un'epoch che la sessione non ha in memoria (rotazione fatta altrove). Si blocca il vault e si lancia: nessuna scrittura. */
async function epochChanged(): Promise<never> {
  await useVaultStore.getState().lockVault();
  throw new MigrationError('epochChanged');
}

/**
 * VK di e-1 per aprire gli envelope stale. Con `keys.prev` in sessione e' quella. Senza (sblocco offline) si legge `prevVkWrap` dal keyring e si apre con la
 * VK corrente, senza PIN ne' /unlock: il contesto locale `ctx2` serve solo a leggere, lo store non cambia (e ctx2.keys non e' "live": il codec non memorizza nulla).
 * Keyring a un'epoch diversa da quella di `ctx` -> classe F.
 */
async function resolvePrev(ctx: VaultCodecCtx, krOf: () => Promise<KeyringInfo>): Promise<PrevState> {
  if (ctx.keys.prev) return { kind: 'ok', ctx };
  const kr = await krOf();
  if (kr.epoch !== ctx.epoch) return epochChanged();
  if (!kr.prevVkWrap) return { kind: 'absent' };
  try {
    const prev = await unwrapPrevVk({ hkdf: ctx.keys.vkHkdf, aes: ctx.keys.vkAes }, b64uDecode(kr.prevVkWrap), ctx.userId, ctx.epoch, ctx.epoch - 1);
    return { kind: 'ok', ctx: { ...ctx, keys: { ...ctx.keys, prev: { epoch: ctx.epoch - 1, vkHkdf: prev.hkdf, vkAes: prev.aes } } } };
  } catch {
    return { kind: 'broken' };
  }
}

/** Epoch dichiarata dall'envelope (NaN se non e' ben formato: ENVELOPE_RE). */
const envelopeEpoch = (content: string) => (ENVELOPE_RE.test(content) ? Number(content.split('.')[1]) : NaN);

export type StaleReason = 'damaged' | 'keyMissing' | 'unverifiable';
type StaleClass = { kind: 'readable'; t: string; c: string } | { kind: 'unreadable'; reason: StaleReason };

/**
 * Classifica un envelope che non e' all'epoch corrente: R = si apre con la VK o con `prev`; D (damaged) = decifrato con una chiave valida (e-1 con `prev`) e l'AEAD
 * ha fallito (tag errato): l'unico caso in cui si puo' dire che i dati sono rotti (D18); K (keyMissing) = e-1 senza `prev` (prevVkWrap nullo o non apribile);
 * U (unverifiable) = nessuna chiave valida lo ha provato: malformato, e-2 o piu' vecchio, epoch maggiore con il keyring ancora a `ctx.epoch`;
 * F = il keyring riletto ha un'epoch diversa da `ctx.epoch` (rotazione fatta altrove): vault bloccato e errore. Solo un cambio vero e' F.
 * Ogni altra eccezione della decifratura e' transitoria: si rilancia (l'item andra' in `failed`).
 */
async function classifyStale(item: ServerItem, ctx: VaultCodecCtx, rd: Readers): Promise<StaleClass> {
  const e = envelopeEpoch(item.content);
  if (Number.isNaN(e)) return { kind: 'unreadable', reason: 'unverifiable' };
  if (e > ctx.epoch) return (await futureEpochIsReal(ctx, rd)) ? epochChanged() : { kind: 'unreadable', reason: 'unverifiable' };
  if (e < ctx.epoch - 1) return { kind: 'unreadable', reason: 'unverifiable' };
  let readCtx = ctx;
  if (e === ctx.epoch - 1) {
    const prev = await rd.prevOf();
    if (prev.kind !== 'ok') return { kind: 'unreadable', reason: 'keyMissing' };
    readCtx = prev.ctx;
  }
  try {
    return { kind: 'readable', ...(await decryptItem(item.id, item.noteType, item.content, readCtx)) };
  } catch (err) {
    const m = (err as Error | null)?.message;
    if (m === 'decryptFailed') return { kind: 'unreadable', reason: 'damaged' }; // AEAD: tag errato con la chiave giusta (vaultCrypto.open)
    if (m === 'invalidEnvelope') return { kind: 'unreadable', reason: 'unverifiable' }; // struttura non valida: puo' uscire anche dopo un AEAD riuscito (payload non {v:1,t,c}, vaultCrypto); U e' comunque l'esito piu' prudente
    throw err; // qualunque altra cosa e' un errore transitorio, non un verdetto sui dati
  }
}

/** Una sola lettura del keyring per giro, e prima di qualsiasi scrittura se c'e' un envelope di epoch diversa da aprire. */
function readersOf(ctx: VaultCodecCtx): Readers {
  let k: Promise<KeyringInfo> | null = null;
  let p: Promise<PrevState> | null = null;
  const krOf = () => (k ??= getKeyring<KeyringInfo>());
  return { krOf, prevOf: () => (p ??= resolvePrev(ctx, krOf)), reread: () => (k = getKeyring<KeyringInfo>()) };
}

/** Envelope ben formato di epoch maggiore: F solo se il keyring ha davvero un'altra epoch; altrimenti e' un dato sbagliato (D). */
async function futureEpochIsReal(ctx: VaultCodecCtx, rd: Readers): Promise<boolean> {
  return (await rd.krOf()).epoch !== ctx.epoch;
}

/** Prima di scrivere: un envelope di epoch futura col keyring a un'altra epoch (o, senza `prev`, un keyring a un'altra epoch) ferma tutto. */
async function assertEpochsKnown(items: ServerItem[], ctx: VaultCodecCtx, rd: Readers) {
  if (items.some((i) => envelopeEpoch(i.content) > ctx.epoch) && (await futureEpochIsReal(ctx, rd))) await epochChanged();
  if (!ctx.keys.prev && items.some((i) => envelopeEpoch(i.content) === ctx.epoch - 1)) await rd.prevOf();
}

/** Tutte le pagine di /items, solo gli item da portare all'epoch corrente (`only`: envelopes = giro di rotazione, legacy = wizard). Nessun GET /notes. */
async function listPending(epoch: number, only?: PendingKind): Promise<ServerItem[]> {
  const out: ServerItem[] = [];
  let after: string | undefined;
  do {
    const page = await getItems<ItemsPage>(after ? { after } : {});
    out.push(...page.items.filter((i) => isPending(i, epoch) && matchesKind(i, only)));
    after = page.next ?? undefined;
  } while (after);
  return out;
}

type PendingKind = 'envelopes' | 'legacy';

/** Solo gli id chiesti: un server che ne restituisce di piu' non allarga mai l'insieme su cui si scrive. */
async function fetchByIds(ids: string[]): Promise<ServerItem[]> {
  const want = new Set(ids);
  const out: ServerItem[] = [];
  for (let i = 0; i < ids.length; i += IDS_CHUNK) out.push(...(await getItems<ItemsPage>({ ids: ids.slice(i, i + IDS_CHUNK) })).items.filter((it) => want.has(it.id)));
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

/** Envelope stale che nessuna chiave apre: non si tocca. `damaged` = e-1 con `prev` ma tag errato (AEAD); `keyMissing` = e-1 senza la VK precedente; `unverifiable` = malformato, e-2 o piu' vecchio, o epoch futura (D18). */
export interface UnreadableItem { id: string; noteType: VaultNoteType; size: number; reason: StaleReason }

export interface RotationResult extends MigrationResult {
  /** Da risolvere con `rewrapUnreadable`, solo dopo conferma dell'utente (D6). */
  unreadable: UnreadableItem[];
}

export interface RotationOptions {
  /** Chiavi dell'utente: epoch corrente `e`, `keys.prev` = VK di e-1. */
  ctx: VaultCodecCtx;
  signal?: AbortSignal;
  onProgress?: (p: MigrationProgress) => void;
  /** Default true: un lock (keys dello store != ctx.keys) ferma il giro. false per il recupero, che lavora con chiavi catturate. */
  live?: boolean;
}

interface Prepared { id: string; noteType: VaultNoteType; t: string; c: string; env: string; baseHash: string; size: number }

/** Passo 6: byte del server riletti, decifrati e confrontati in modo esatto con l'originale; solo i verificati vanno a finalize. */
async function verifyFinalize(ctx: VaultCodecCtx, sent: Prepared[]): Promise<{ migrated: number; unverified: string[] }> {
  const byId = new Map(sent.map((p) => [p.id, p]));
  const verified: string[] = [];
  const out = { migrated: 0, unverified: [] as string[] };
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
    else out.unverified.push(it.id);
  }
  for (const id of byId.keys()) out.unverified.push(id); // spariti dal listing del server
  for (let i = 0; i < verified.length; i += FINALIZE_CHUNK) {
    const chunk = verified.slice(i, i + FINALIZE_CHUNK);
    const f = await finalizeItems<{ finalized: number; rejected: string[] }>(chunk);
    const rejected = new Set(f.rejected);
    out.migrated += chunk.length - rejected.size;
    out.unverified.push(...rejected);
  }
  return out;
}

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

async function migrateCore(opts: MigrationOptions & { live?: boolean; only?: PendingKind }): Promise<RotationResult> {
  const { ctx, pins, signal } = opts;
  const dec = opts.decryptor ?? createLegacyDecryptor();
  const unlock = makeLegacyUnlocker(pins, dec);
  const res: RotationResult = { migrated: 0, locked: [], tooLarge: [], conflicts: [], unverified: [], failed: [], notFound: 0, withAttachments: 0, unreadable: [] };
  const settled = new Set<string>();
  const rd = readersOf(ctx);
  let total = 0;
  const tick = (id: string) => {
    settled.add(id);
    opts.onProgress?.({ done: settled.size, total });
  };
  const check = () => {
    if (signal?.aborted) throw new MigrationError('aborted');
    if (opts.live !== false && useVaultStore.getState().keys !== ctx.keys) throw new MigrationError('locked'); // lock durante il giro
  };

  const prepare = async (item: ServerItem): Promise<Prepared | null> => {
    try {
      let t = item.title;
      let c: string;
      if (item.content.startsWith('nv3.')) {
        // envelope di un altro epoch: si apre con la VK o con prev (e-1); se nessuna chiave lo apre resta intatto e va a `unreadable`
        const k = await classifyStale(item, ctx, rd);
        if (k.kind === 'unreadable') {
          res.unreadable.push({ id: item.id, noteType: item.noteType, size: item.content.length, reason: k.reason });
          tick(item.id);
          return null;
        }
        ({ t, c } = k);
      } else {
        const c0 = classify(item);
        if (c0.kind === 'locked') {
          const unlocked = await unlock(item.content); // se un Worker muore rifiuta: l'item finisce in `failed`, gli altri proseguono
          if (unlocked == null) { res.locked.push(item.id); tick(item.id); return null; }
          c = unlocked;
        } else {
          t = c0.t;
          c = c0.c;
        }
      }
      const env = await encryptItem(item.id, item.noteType, { t, c }, ctx);
      if (env.length > MAX_ENVELOPE_LEN) { res.tooLarge.push(item.id); tick(item.id); return null; }
      const back = await decryptItem(item.id, item.noteType, env, ctx);
      if (back.t !== t || back.c !== c) throw new Error('roundTrip');
      return { id: item.id, noteType: item.noteType, t, c, env, baseHash: await sha256hex(item.content), size: env.length + ITEM_OVERHEAD };
    } catch (err) {
      if (err instanceof MigrationError) throw err; // epochChanged, locked, ...: ferma il giro, non e' un fallimento della nota
      res.failed.push(item.id);
      tick(item.id);
      return null;
    }
  };

  const verifyAndFinalize = async (sent: Prepared[]) => {
    const v = await verifyFinalize(ctx, sent);
    res.migrated += v.migrated;
    res.unverified.push(...v.unverified);
    sent.forEach((p) => tick(p.id));
  };

  try {
    let queue = await listPending(ctx.epoch, opts.only);
    await assertEpochsKnown(queue, ctx, rd); // prima di qualsiasi scrittura
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
      if (conflicted.length > 0) {
        if ((await rd.reread()).epoch !== ctx.epoch) await epochChanged(); // rotazione fatta altrove durante la passata: niente dati vecchi
        queue = (await fetchByIds(conflicted)).filter((i) => isPending(i, ctx.epoch) && matchesKind(i, opts.only));
      } else queue = [];
    }
  } finally {
    if (!opts.decryptor) dec.terminate();
  }
  return res;
}

/** Wizard legacy: solo content NON envelope. Gli envelope di un'altra epoch li tocca solo `finishRotation`. */
export async function migrateLegacy(opts: MigrationOptions): Promise<MigrationResult> {
  const { unreadable: _unreadable, ...res } = await migrateCore({ ...opts, only: 'legacy' });
  return res;
}

/** Sotto `notiq-vault-reconcile` (stesso lock del reconcile). Senza navigator.locks gira lo stesso: a proteggere gli altri dispositivi e' il CAS. */
async function underReconcileLock<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const out = await withReconcileLock(fn, signal);
  if (out.status === 'ran') return out.value;
  if (out.status === 'busy') throw new MigrationError('busy');
  return fn();
}

/**
 * Fine di una rotazione della VK: porta all'epoch corrente gli envelope di e-1 (con `keys.prev` o con la VK letta da `prevVkWrap`). Le legacy SL non
 * entrano (le migra `migrateLegacy`). Scrive solo sul server (CAS su baseHash, verifica dai byte del server, finalize); mai Dexie, coda o storage.
 * Gli envelope che nessuna chiave apre non si toccano: tornano in `unreadable` e li risolve `rewrapUnreadable` dopo conferma (D6).
 */
export function finishRotation(opts: RotationOptions): Promise<RotationResult> {
  return underReconcileLock(() => migrateCore({ ...opts, pins: [], only: 'envelopes' }), opts.signal);
}

export interface RewrapResult {
  /** Re-incapsulati all'epoch corrente, verificati e finalizzati. */
  rewrapped: string[];
  /** Envelope vecchio oltre `MAX_REWRAP_LEN` (o il re-incapsulamento oltre il tetto del server): intatto, la UI chiede di cancellarla a mano (D7). */
  tooLarge: string[];
  /** Nel frattempo gia' all'epoch corrente, decifrabile (la riprende `finishRotation`) o portata all'epoch corrente da un altro dispositivo (`already`): saltata. */
  readable: string[];
  /** K (serve la VK precedente, mancante sul server) o U (non verificabile) e l'id non e' in `allowKeyMissingIds`: intatta. */
  keyMissing: string[];
  /** Cambiata sul server nel frattempo (CAS perso): saltata, si rilancia il giro. */
  conflicts: string[];
  /** Re-incapsulato ma non verificato dai byte del server, o rifiutato da finalize. */
  unverified: string[];
  /** Cifratura, round-trip o contenuto non envelope: non inviata. */
  failed: string[];
  notFound: number;
}

const rewrapNoteText = () => {
  const k = 'vault.rotation.unreadableNote';
  const raw = i18n.t(k);
  return raw && raw !== k ? raw : 'This content could not be decrypted after a key change. The original encrypted data is kept below.';
};
const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });

/**
 * D6: re-incapsula all'epoch corrente le note ancora illegibili (SOLO dopo la conferma dell'utente). Rilegge dal server: una nota diventata
 * leggibile o gia' corrente si salta. L'envelope vecchio resta copiato tale e quale nel nuovo contenuto (NOTE: secondo paragrafo; CREDENTIAL: `notes`).
 */
export function rewrapUnreadable(ids: string[], ctx: VaultCodecCtx, o: { signal?: AbortSignal; live?: boolean; allowKeyMissingIds?: string[] } = {}): Promise<RewrapResult> {
  return underReconcileLock(async () => {
    const res: RewrapResult = { rewrapped: [], tooLarge: [], readable: [], keyMissing: [], conflicts: [], unverified: [], failed: [], notFound: 0 };
    const check = () => {
      if (o.signal?.aborted) throw new MigrationError('aborted');
      if (o.live !== false && useVaultStore.getState().keys !== ctx.keys) throw new MigrationError('locked');
    };
    const items = await fetchByIds(ids);
    res.notFound = ids.length - items.length;
    const rd = readersOf(ctx);
    const allowK = new Set(o.allowKeyMissingIds);
    await assertEpochsKnown(items, ctx, rd); // prima di qualsiasi scrittura
    const prepared: Prepared[] = [];
    for (const item of items) {
      check();
      try {
        const old = item.content;
        if (!old.startsWith('nv3.')) { res.failed.push(item.id); continue; } // legacy: e' il giro normale
        if (!isPending(item, ctx.epoch)) { res.readable.push(item.id); continue; }
        const k = await classifyStale(item, ctx, rd);
        if (k.kind === 'readable') { res.readable.push(item.id); continue; }
        if (k.reason !== 'damaged' && !allowK.has(item.id)) { res.keyMissing.push(item.id); continue; } // K e U: serve il consenso per nota
        if (old.length > MAX_REWRAP_LEN) { res.tooLarge.push(item.id); continue; }
        const t = item.title;
        const c = item.noteType === 'NOTE'
          ? JSON.stringify({ type: 'doc', content: [para(rewrapNoteText()), para(old)] })
          : JSON.stringify({ ...EMPTY_CREDENTIAL, notes: old });
        const env = await encryptItem(item.id, item.noteType, { t, c }, ctx);
        if (env.length > MAX_ENVELOPE_LEN) { res.tooLarge.push(item.id); continue; }
        const back = await decryptItem(item.id, item.noteType, env, ctx);
        if (back.t !== t || back.c !== c) throw new Error('roundTrip');
        prepared.push({ id: item.id, noteType: item.noteType, t, c, env, baseHash: await sha256hex(old), size: env.length + ITEM_OVERHEAD });
      } catch (err) {
        if (err instanceof MigrationError) throw err;
        res.failed.push(item.id);
      }
    }
    for (const batch of packBatches(prepared)) {
      check();
      const body: MigrateItem[] = batch.map((p) => ({ id: p.id, baseHash: p.baseHash, content: p.env, noteType: p.noteType }));
      const { results } = await migrateItems<{ results: { id: string; status: string }[] }>(body);
      const byId = new Map(batch.map((p) => [p.id, p]));
      const ok: Prepared[] = [];
      for (const r of results) {
        const p = byId.get(r.id);
        if (!p) continue;
        if (r.status === 'ok') ok.push(p);
        else if (r.status === 'already') res.readable.push(p.id); // un altro dispositivo l'ha gia' portata all'epoch corrente: la riprende finishRotation
        else if (r.status === 'conflict') res.conflicts.push(p.id);
        else if (r.status === 'notFound') res.notFound++;
        else throw new MigrationError('invalid');
      }
      if (ok.length > 0) {
        const v = await verifyFinalize(ctx, ok);
        const bad = new Set(v.unverified);
        res.rewrapped.push(...ok.map((p) => p.id).filter((id) => !bad.has(id)));
        res.unverified.push(...v.unverified);
      }
    }
    return res;
  }, o.signal);
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
