import i18n from 'i18next';
import { db, type LocalNote, type SyncQueueItem } from './db';
import { finalizeItems, getItems, type VaultIdsExtra } from './vaultApi';
import { decryptItem, encryptItem, type VaultCodecCtx, type VaultNoteType } from './vaultCodec';
import { hasLocks, withNoteLock, withReconcileLock } from './vaultNoteLock';
import { useAuthStore } from '../store/authStore';
import { useVaultStore } from '../store/vaultStore';
import { ENVELOPE_RE, sha256hex } from '../utils/vaultCrypto';

// Vault v3 (T15, spec 2026-10-22-vault-t15-reconcile-spec.md): riallinea Dexie col server per le note vault.
// Tre stadi per nota: decide(snapshot) pura (tabella T1-T15), prepare (crypto, FUORI da ogni transazione), commit (una sola
// transazione Dexie, che riconfronta lo snapshot e se e' cambiato rinuncia: LATER). Nota per nota sotto il Web Lock della nota
// (ifAvailable); il giro intero sotto il lock del giro, in attesa. Invarianti: nessun plaintext in Dexie/coda/log (solo envelope),
// titoli e testi solo in memoria; ogni dato locale si scarta solo dopo che la copia e' stata cifrata e riletta.
// Condiviso fra features (lib/): niente import da features/ (le copie scrivono Dexie e coda direttamente).

export interface ServerItem {
  id: string;
  noteType: VaultNoteType;
  title: string;
  hasPlaintextVersions: boolean;
  content: string;
  contentHash: string;
  updatedAt: string;
  isTrashed: boolean;
}
interface ItemsPage extends VaultIdsExtra { items: ServerItem[]; next: string | null }

export interface ReconcileOptions {
  /** Credenziali v2/legacy: testo in chiaro decifrato con i vecchi PIN della sessione di migrazione, null se non decifrabili. */
  decryptLegacy?: (row: LocalNote) => Promise<string | null>;
  /** Interrompe l'attesa del lock del giro (T20 "riprova"): il risultato e' skipped:'busy'. */
  signal?: AbortSignal;
}

export interface ReconcileResult {
  /** Giro non eseguito. 'locked' = precondizione K assente della spec (P2, SKIP): vault bloccato o chiavi di un altro utente, niente da fare finche'
   *  non si sblocca. 'notReady' = keyring non READY per l'epoch corrente. 'busy' = attesa del lock del giro interrotta dal signal (T20 "riprova"). */
  skipped?: 'locked' | 'notReady' | 'busy';
  /** Il vault si e' bloccato durante il giro: il resto riparte al prossimo. */
  aborted?: boolean;
  hydrated: number;
  conflictsResolved: number;
  copies: number;
  legacyResolved: number;
  reactivated: number;
  finalized: number;
  /** Item del server non ancora envelope dell'epoch corrente (banner "N elementi da aggiornare"). */
  legacyLeft: number;
  /** Note lasciate com'erano: non decifrabili, epoch diverso, rinviate (incluse in `later`), errori. */
  unresolved: number;
  /** Rinviate al prossimo giro: lock della nota tenuto altrove, snapshot cambiato fra decide e commit, server non raggiungibile. */
  later: number;
  /** Note con riga lasciate per legacyPin (incluse in `unresolved`): banner del PIN precedente. */
  legacyPin: number;
}

const FINALIZE_CHUNK = 500;
const IDS_CHUNK = 200; // max di `ids` accettato dal server
const MAX_ENVELOPE_LEN = 2 * 1024 * 1024; // oltre non passa il limite del server: niente copia
const SUFFIX_KEY = 'vault.conflictCopySuffix';
const STRIP_KEYS = new Set(['content', 'title', 'isEncrypted', 'isVault']);

// ---------------------------------------------------------------------------------------------------------------------
// Tipi e funzioni pure
// ---------------------------------------------------------------------------------------------------------------------

export interface Payload { t: string; c: string }
/** Perche' il payload locale non si ottiene: envelope di un altro epoch, non decifrabile, credenziale legacy senza il vecchio PIN. */
export type Fail = 'decrypt' | 'legacyPin' | 'epoch';
export type LeaveWhy = Fail | 'size' | 'roundTrip' | 'legacyLeft' | 'notebook' | 'unchanged';
/** Stato del server per l'id: S? (unknown) = rete/5xx/429, mai "assente". */
export type Srv = { k: 'unknown' } | { k: 'S0' } | { k: 'SN' } | { k: 'item'; item: ServerItem };

export interface Snapshot {
  id: string;
  userId: string;
  epoch: number;
  /** K: chiavi del vault disponibili. */
  k: boolean;
  /** held = lock della nota nostro, busy = tenuto da un'altra scheda, none = navigator.locks assente. */
  lock: 'held' | 'busy' | 'none';
  row?: LocalNote;
  /** Item NOTE di coda dell'utente per questo id. */
  items: SyncQueueItem[];
  srv: Srv;
  /** sha256 del content della riga, se e' un envelope. */
  hl?: string;
  /** sha256 del content dell'item del server (Hs). */
  hs?: string;
  /** Payload locale {t,c} (da decifratura o chiaro legacy), o il motivo per cui non c'e'. undefined = niente da proteggere. */
  P?: Payload | Fail;
  /** P coincide col payload del server. */
  same?: boolean;
  /** Server SE il cui payload e' stato decifrato in withFacts: T6 puo' adottarlo anche senza P. */
  srvOk?: boolean;
  /** Impronta di riga e coda al momento dello snapshot (precondizione 7, controllata dal commit). */
  sig?: string;
  /** listSig di riga e coda al momento del listing del server (precondizione 7, controllata anche dal commit). */
  listed?: string;
}

export type Op =
  | 'NONE' | 'SKIP' | 'LATER' | 'LEAVE'
  | 'HYDRATE' | 'ACK' | 'REQUEUE' | 'SYNC' | 'QUEUE_CONTENT' | 'STRIP_REQUEUE'
  | 'ADOPT' | 'REENCRYPT_TITLE' | 'STRIP_CONTENT' | 'REENCRYPT_CREATE' | 'REFRESH_CREATE'
  | 'DROP' | 'UNVAULT' | 'DROP_ITEMS';

export interface Decision {
  /** P1-P6 precondizioni, T1-T15 tabella della spec, 'Qf' = errore non vault (lo gestisce retryFailedSyncItems). */
  rule: string;
  op: Op;
  why?: LeaveWhy;
  /** Prima dell'op va creata la copia di P: 'vault' = nota vault cifrata, 'plain' = nota normale in chiaro. */
  copy?: 'vault' | 'plain';
}

const isEnv = (c: string | undefined): c is string => !!c && ENVELOPE_RE.test(c);
const envEpoch = (c: string) => Number(c.split('.')[1]);
const isCurrentEnvelope = (c: string | undefined, epoch: number) => isEnv(c) && envEpoch(c) === epoch;
/** SE = envelope dell'epoch corrente, SX = envelope di un altro epoch, SL = vault legacy (content non envelope). */
export const srvClass = (item: ServerItem, epoch: number): 'SE' | 'SX' | 'SL' =>
  !isEnv(item.content) ? 'SL' : envEpoch(item.content) === epoch ? 'SE' : 'SX';

const titleOf = (i: SyncQueueItem) => (typeof i.data?.title === 'string' ? i.data.title : '');
const hasPlainContent = (i: SyncQueueItem) => typeof i.data?.content === 'string' && !ENVELOPE_RE.test(i.data.content);
const byId = (a: SyncQueueItem, b: SyncQueueItem) => (a.id ?? 0) - (b.id ?? 0);
/** Ultimo titolo in chiaro degli item (i vecchi bundle lo mettevano nella coda), '' se non c'e'. */
const lastTitle = (items: SyncQueueItem[]) => [...items].sort(byId).map(titleOf).filter(Boolean).pop() ?? '';
const isFailed = (i: SyncQueueItem) => i.status === 'failed';
const vaultFailed = (i: SyncQueueItem) => isFailed(i) && (i.lastError ?? '').startsWith('vault:');
/** Payload che il server rifiuterebbe su una riga envelope: isEncrypted false, o isVault in un UPDATE. */
const uncleanKeys = (i: SyncQueueItem) =>
  i.type !== 'DELETE' && (i.data?.isEncrypted === false || (i.type !== 'CREATE' && !!i.data && 'isVault' in i.data));
/** T5: lo strip cambierebbe il payload dell'item (title / isVault / isEncrypted:false da togliere; per la CREATE, payload diverso dal canonico). */
const stripChanges = (i: SyncQueueItem, rowContent: string) => {
  const d = i.data ?? {};
  if (i.type === 'CREATE') return d.title !== '' || d.content !== rowContent || d.isEncrypted !== true || d.isVault !== true;
  return 'title' in d || 'isVault' in d || d.isEncrypted === false;
};
/** T5: un item vault:* o non pulito si riattiva solo se lo strip cambia il payload o, per stale/notReady, se il content dell'item non e' quello
 *  che ha fallito (la riga e' stata ricifrata dopo): altrimenti ripartirebbe lo stesso payload, fallirebbe uguale e il giro lo riattiverebbe all'infinito. */
const reactivates = (i: SyncQueueItem, rowContent: string) => {
  if (i.type === 'DELETE' || !(vaultFailed(i) || uncleanKeys(i))) return false;
  if (stripChanges(i, rowContent)) return true;
  return i.lastError === 'vault:stale' || i.lastError === 'vault:notReady' ? i.data?.content !== rowContent : true;
};
const noteTypeOf = (n: { noteType?: string } | undefined): VaultNoteType => (n?.noteType === 'CREDENTIAL' ? 'CREDENTIAL' : 'NOTE');

/** LP: riga vault con titolo in chiaro, contenuto non envelope, o item di coda con titolo / content in chiaro. */
export const isLegacyShape = (row: LocalNote, items: SyncQueueItem[]) =>
  !!row.isVault && ((row.content !== '' && !isEnv(row.content)) || row.title !== '' ||
    items.some((i) => i.type !== 'DELETE' && (titleOf(i) !== '' || hasPlainContent(i))));

/** U: c'e' lavoro locale non ancora sul server (riga sporca o item in coda). */
const hasU = (row: LocalNote, items: SyncQueueItem[]) => row.syncStatus !== 'synced' || items.some((i) => i.type !== 'DELETE');

const R = (rule: string, op: Op, extra: Partial<Decision> = {}): Decision => ({ rule, op, ...extra });
const leave = (rule: string, why: LeaveWhy) => R(rule, 'LEAVE', { why });
/** L'op con la copia di P davanti; P non ottenibile -> LEAVE, P assente (niente da proteggere) -> l'op senza copia. */
const withCopy = (s: Snapshot, rule: string, op: Op, kind: 'vault' | 'plain' = 'vault'): Decision =>
  typeof s.P === 'string' ? leave(rule, s.P) : s.P ? R(rule, op, { copy: kind }) : R(rule, op);

// Senza navigator.locks (spec, precondizione 5) si fa solo quanto non scrive contenuto: niente, rinvii, e REQUEUE (riporta pending gli item
// falliti). ACK e' ammessa perche' non scrive contenuto ne' item nuovi: aggiorna solo vaultBaseHash (il server ha gia' i nostri byte) e poi
// fa REQUEUE; senza lock non c'e' modo di coordinarsi con l'editor, ma il peggio e' una base piu' fresca di quella che la push avrebbe letto.
const SAFE_WITHOUT_LOCKS = new Set<Op>(['NONE', 'SKIP', 'LATER', 'LEAVE', 'REQUEUE', 'ACK']);

/** La tabella T1-T15 con le precondizioni nell'ordine della spec (vince la prima). Pura: niente I/O, niente crypto. */
export function decide(s: Snapshot): Decision {
  const d = core(s);
  if (s.lock === 'none' && !SAFE_WITHOUT_LOCKS.has(d.op)) return R('P5', 'LATER');
  return d;
}

function core(s: Snapshot): Decision {
  const { row, items } = s;
  // 1. Z: solo righe e item dell'utente collegato, mai le condivise.
  if (row ? row.userId !== s.userId || row.ownership === 'shared' : items.some((i) => i.userId !== s.userId)) return R('P1', 'NONE');
  if (!s.k) return R('P2', 'SKIP');
  if (items.some((i) => i.type === 'DELETE')) return R('P3', 'NONE'); // QD: una cancellazione in coda
  if (s.lock === 'busy') return R('P4', 'LATER');
  if (!row) return s.items.some(vaultFailed) ? withCopy(s, 'T15', 'DROP_ITEMS') : R('T15', 'NONE');
  if (s.srv.k === 'unknown') return R('P6', 'LATER');
  return row.isVault ? vaultRow(s, row) : plainRow(s, row);
}

/** Riga NON vault (LN): LNp = content non envelope, LNe = content envelope (nasce solo senza navigator.locks). */
function plainRow(s: Snapshot, row: LocalNote): Decision {
  const { srv, items } = s;
  const env = isEnv(row.content);
  const u = hasU(row, items);
  if (srv.k === 'item') {
    const c = srvClass(srv.item, s.epoch);
    if (c === 'SX') return leave('T14', 'epoch');
    if (c === 'SL') return leave('T14', 'legacyLeft'); // dopo T20 diventa SE e si risolve con T12
    return env || u ? withCopy(s, 'T12', 'ADOPT') : R('T12', 'ADOPT');
  }
  if (srv.k === 'SN') {
    if (env) return withCopy(s, 'T13', 'DROP');
    return items.some(vaultFailed) ? R('T13', 'UNVAULT') : R('T13', 'NONE');
  }
  if (env) return withCopy(s, 'T13', 'DROP');
  return u ? withCopy(s, 'T13', 'DROP', 'plain') : R('T13', 'DROP');
}

function vaultRow(s: Snapshot, row: LocalNote): Decision {
  const { srv, items } = s;
  if (srv.k === 'SN') return hasU(row, items) ? withCopy(s, 'T11', 'DROP') : R('T11', 'DROP');
  if (srv.k === 'S0') return s0Row(s, row);
  if (srv.k !== 'item') return R('P6', 'LATER');
  const c = srvClass(srv.item, s.epoch);
  if (c === 'SX') return leave('T8', 'epoch');
  if (c === 'SL') return t7(s, row, srv.item);
  return seRow(s, row);
}

const canonicalCreate = (row: LocalNote, items: SyncQueueItem[], create: SyncQueueItem) =>
  !isFailed(create) && create.data?.content === row.content && create.data?.title === '' &&
  create.data?.isEncrypted === true && create.data?.isVault === true &&
  !items.some((i) => vaultFailed(i) || uncleanKeys(i));

function s0Row(s: Snapshot, row: LocalNote): Decision {
  if (!hasU(row, s.items)) return R('T10', 'DROP');
  const create = s.items.find((i) => i.type === 'CREATE');
  if (!create) return withCopy(s, 'T10', 'DROP');
  if (isLegacyShape(row, s.items)) {
    if (typeof s.P === 'string') return leave('T9', s.P);
    return s.P ? R('T9', 'REENCRYPT_CREATE') : leave('T9', 'decrypt');
  }
  if (row.content === '') return R('T9', 'NONE');
  if (!isCurrentEnvelope(row.content, s.epoch)) return leave('T9', 'epoch');
  return canonicalCreate(row, s.items, create) ? R('T9', 'NONE') : R('T9', 'REFRESH_CREATE');
}

function t7(s: Snapshot, row: LocalNote, sv: ServerItem): Decision {
  const clean = row.syncStatus === 'synced' && !s.items.length;
  if (row.content === '' && row.title === '' && !s.items.length) return R('T7', 'NONE');
  // Riga gia' envelope e server ancora legacy: niente da adottare (scriverebbe in Dexie il chiaro del server), si aspetta la migrazione.
  if (isEnv(row.content)) return clean ? R('T7', 'NONE') : leave('T7', 'legacyLeft');
  if (s.same) return row.syncStatus === 'synced' && !s.items.length && row.content === sv.content ? R('T7', 'NONE') : R('T7', 'ADOPT');
  return withCopy(s, 'T7', 'ADOPT');
}

function t6(s: Snapshot, row: LocalNote): Decision {
  if (s.same) return R('T6', 'ADOPT');
  // P non ottenibile: senza lavoro locale la riga e' una copia vecchia del server (B.12); con lavoro locale serve il PIN precedente (B.13)
  if (typeof s.P === 'string') return !hasU(row, s.items) && s.srvOk ? R('T6', 'ADOPT') : leave('T6', s.P);
  const envRow = isEnv(row.content) && row.title === '';
  const titleItems = s.items.filter((i) => titleOf(i) !== '');
  const plainItems = s.items.filter(hasPlainContent);
  if (envRow && s.P && titleItems.length && !plainItems.length) return R('T6', 'REENCRYPT_TITLE');
  if (envRow && plainItems.length && !titleItems.length) return R('T6', 'STRIP_CONTENT');
  return withCopy(s, 'T6', 'ADOPT');
}

/** Riga vault, server con envelope dell'epoch corrente. */
function seRow(s: Snapshot, row: LocalNote): Decision {
  const { items, hs, hl } = s;
  if (isLegacyShape(row, items)) return t6(s, row);
  const base = row.vaultBaseHash;
  const sent = row.vaultSentHashes ?? [];
  const failed = items.filter(isFailed);
  const conflicts = failed.filter((i) => i.lastError === 'vault:conflict');
  const vfail = failed.filter((i) => vaultFailed(i) && i.lastError !== 'vault:conflict');
  const unclean = items.some(uncleanKeys);

  if (conflicts.length) {
    if (hs !== undefined && (hs === hl || sent.includes(hs))) return R('T2', 'ACK'); // risposta persa: il server ha gia' i nostri byte
    if (hs === base) return R('T3', 'REQUEUE'); // la PUT era partita con una base vecchia (altra scheda)
    return withCopy(s, 'T3', 'ADOPT');
  }
  if ((vfail.length || unclean) && row.content !== '') {
    if (!isCurrentEnvelope(row.content, s.epoch)) return leave('T5', 'epoch');
    return items.some((i) => reactivates(i, row.content)) ? R('T5', 'STRIP_REQUEUE') : leave('T5', 'unchanged');
  }
  if (!vfail.length && !unclean && failed.length) return R('Qf', 'NONE'); // validation/not_found/forbidden/network: retryFailedSyncItems
  if (row.content === '' || row.syncStatus === 'synced') return hs !== base ? R('T1', 'HYDRATE') : R('T1', 'NONE');

  // T4: riga sporca, coda pulita
  if (hs !== undefined && hs === hl) return R('T4', 'SYNC');
  if (hs === base || (hs !== undefined && sent.includes(hs))) {
    const hasContentItem = items.some((i) => i.type === 'CREATE' || (!!i.data && 'content' in i.data));
    return base !== hs || !hasContentItem ? R('T4', 'QUEUE_CONTENT') : R('T4', 'NONE');
  }
  return withCopy(s, 'T4', 'ADOPT');
}

// ---------------------------------------------------------------------------------------------------------------------
// Snapshot: lettura e fatti crittografici (fuori da ogni transazione)
// ---------------------------------------------------------------------------------------------------------------------

const noteItems = (userId: string, entityId?: string) =>
  db.syncQueue.filter((i) => i.entity === 'NOTE' && i.userId === userId && (entityId === undefined || i.entityId === entityId)).toArray();

const sigOf = (row: LocalNote | undefined, items: SyncQueueItem[]) =>
  JSON.stringify([
    row ? [row.content, row.updatedAt, row.syncStatus, row.isVault ?? null, row.vaultBaseHash ?? null] : null,
    items.map((i) => [i.id, i.type, i.status ?? null, i.lastError ?? null, i.data ?? null]),
  ]);

/** Firma di quello che una push o un'altra scheda cambiano senza toccare il content: base CAS, stato e data della riga, id+stato+errore degli item. */
const listSig = (row: LocalNote | undefined, items: SyncQueueItem[]) =>
  JSON.stringify([
    row ? [row.vaultBaseHash ?? null, row.syncStatus, row.updatedAt] : null,
    items.map((i) => [i.id, i.status ?? null, i.lastError ?? null]),
  ]);

async function localPayload(ctx: VaultCodecCtx, row: LocalNote, items: SyncQueueItem[], sp: Payload | Fail | undefined, opts: ReconcileOptions): Promise<Payload | Fail | undefined> {
  // Riga non envelope senza titolo (ne' negli item): la pull azzera il title delle righe vault -> titolo del server anche su riga sporca
  const t0 = lastTitle(items) || row.title || (!isEnv(row.content) && sp && typeof sp === 'object' ? sp.t : '');
  let c: string | undefined;
  let dt = '';
  if (isEnv(row.content)) {
    if (envEpoch(row.content) !== ctx.epoch) return 'epoch';
    try {
      const d = await decryptItem(row.id, noteTypeOf(row), row.content, ctx);
      c = d.c;
      dt = d.t;
    } catch {
      return 'decrypt';
    }
  } else if (row.content !== '') {
    if (row.isVault && row.noteType === 'CREDENTIAL') {
      let p: string | null | undefined;
      try {
        p = await opts.decryptLegacy?.(row);
      } catch {
        p = null;
      }
      if (p == null) return 'legacyPin';
      c = p;
    } else c = row.content;
  } else if (sp && typeof sp === 'object') {
    c = sp.c;
    dt = sp.t;
  }
  return c === undefined ? undefined : { t: t0 || dt, c };
}

/** Riga assente (T15): il payload viene dall'ultimo item con un content. */
async function itemPayload(ctx: VaultCodecCtx, id: string, items: SyncQueueItem[]): Promise<Payload | Fail | undefined> {
  const last = [...items].sort(byId).filter((i) => typeof i.data?.content === 'string').pop();
  if (!last) return undefined;
  const content = last.data?.content as string;
  const t = lastTitle(items);
  if (!isEnv(content)) return last.data?.noteType === 'CREDENTIAL' ? 'legacyPin' : { t, c: content };
  if (envEpoch(content) !== ctx.epoch) return 'epoch';
  try {
    const d = await decryptItem(id, noteTypeOf(last.data), content, ctx);
    return { t: t || d.t, c: d.c };
  } catch {
    return 'decrypt';
  }
}

async function withFacts(s: Snapshot, ctx: VaultCodecCtx, opts: ReconcileOptions): Promise<Snapshot> {
  const { row, items, srv } = s;
  const out: Snapshot = { ...s };
  try {
    if (!row) {
      out.P = await itemPayload(ctx, s.id, items);
      return out;
    }
    const sv = srv.k === 'item' ? srv.item : undefined;
    if (sv) out.hs = await sha256hex(sv.content);
    if (isEnv(row.content)) out.hl = await sha256hex(row.content);
    const lp = isLegacyShape(row, items);
    if (!(!row.isVault || lp || row.syncStatus !== 'synced' || items.length > 0)) return out; // niente da proteggere
    const cls = sv ? srvClass(sv, s.epoch) : null;
    if (sv && cls === 'SL' && row.isVault) {
      // Credenziale legacy invariata: stessi byte del server, niente da decifrare ne' da proteggere (e nessun decryptLegacy).
      const t = lastTitle(items) || row.title;
      if (row.content === sv.content && (t === '' || t === sv.title)) {
        out.same = true;
        return out;
      }
    }
    let sp: Payload | Fail | undefined;
    if (sv && row.isVault && (lp || cls === 'SL')) {
      if (cls === 'SL') sp = { t: sv.title, c: sv.content };
      else {
        try {
          sp = await decryptItem(s.id, sv.noteType, sv.content, ctx);
        } catch {
          sp = 'decrypt';
        }
      }
    }
    out.srvOk = cls === 'SE' && typeof sp === 'object';
    out.P = await localPayload(ctx, row, items, sp, opts);
    if (typeof out.P === 'object' && sp && typeof sp === 'object' && out.P.t === sp.t && out.P.c === sp.c) out.same = true;
  } catch {
    out.P = 'decrypt';
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Prepare: copie e ri-cifrature
// ---------------------------------------------------------------------------------------------------------------------

interface CopySpec { id: string; vault: boolean; noteType: VaultNoteType; notebookId: string; title: string; content: string }
interface Plan { copy?: CopySpec; env?: string }
type Prepared = { plan: Plan } | { leave: LeaveWhy };

const copySuffix = () => {
  const raw = i18n.t(SUFFIX_KEY);
  return raw && raw !== SUFFIX_KEY ? raw : '(conflict copy)';
};

async function seal(ctx: VaultCodecCtx, id: string, noteType: VaultNoteType, p: Payload): Promise<{ env: string } | { leave: LeaveWhy }> {
  const env = await encryptItem(id, noteType, p, ctx);
  if (env.length > MAX_ENVELOPE_LEN) return { leave: 'size' };
  const back = await decryptItem(id, noteType, env, ctx);
  return back.t === p.t && back.c === p.c ? { env } : { leave: 'roundTrip' };
}

async function prepare(s: Snapshot, d: Decision, ctx: VaultCodecCtx): Promise<Prepared> {
  const plan: Plan = {};
  const P = typeof s.P === 'object' ? s.P : undefined;
  if (d.copy && P) {
    const last = [...s.items].sort(byId).pop();
    const notebookId = s.row?.notebookId ?? s.items.map((i) => i.data?.notebookId).find((n): n is string => typeof n === 'string' && n !== '');
    if (!notebookId) return { leave: 'notebook' };
    const noteType = s.row ? noteTypeOf(s.row) : noteTypeOf(last?.data);
    const id = crypto.randomUUID();
    const title = `${P.t} ${copySuffix()}`.trim();
    if (d.copy === 'vault') {
      const sealed = await seal(ctx, id, noteType, { t: title, c: P.c });
      if ('leave' in sealed) return sealed;
      plan.copy = { id, vault: true, noteType, notebookId, title: '', content: sealed.env };
    } else {
      if (P.c.length > MAX_ENVELOPE_LEN) return { leave: 'size' }; // stesso limite del server delle copie cifrate
      plan.copy = { id, vault: false, noteType, notebookId, title, content: P.c };
    }
  }
  if ((d.op === 'REENCRYPT_TITLE' || d.op === 'REENCRYPT_CREATE') && P && s.row) {
    const t = d.op === 'REENCRYPT_TITLE' ? lastTitle(s.items) : P.t;
    const sealed = await seal(ctx, s.row.id, noteTypeOf(s.row), { t, c: P.c });
    if ('leave' in sealed) return sealed;
    plan.env = sealed.env;
  }
  return { plan };
}

// ---------------------------------------------------------------------------------------------------------------------
// Commit: una transazione Dexie per nota (solo chiamate Dexie, nessun await di altro tipo)
// ---------------------------------------------------------------------------------------------------------------------

const requeue = (id: number | undefined, data?: Record<string, unknown>) =>
  db.syncQueue.update(id as number, { ...(data ? { data } : {}), status: 'pending' as const, lastError: undefined, attempts: 0 });

const canonicalCreateData = (data: Record<string, unknown> | undefined, content: string) => ({ ...(data ?? {}), title: '', content, isEncrypted: true, isVault: true });

/** T5: gli item con errore vault:* o con payload non pulito tornano pending; title/isVault/isEncrypted:false si tolgono, la CREATE si ricostruisce
 *  dalla riga (id, notebookId, noteType restano). Un item che resta vuoto si cancella. Ritorna quanti item falliti si sono riattivati. */
async function requeueVault(userId: string, id: string, rowContent: string, gated = false): Promise<number> {
  let n = 0;
  for (const it of await noteItems(userId, id)) {
    if (it.type === 'DELETE' || !(vaultFailed(it) || uncleanKeys(it))) continue;
    if (gated && !reactivates(it, rowContent)) continue;
    if (vaultFailed(it)) n++;
    if (it.type === 'CREATE') {
      await requeue(it.id, canonicalCreateData(it.data, rowContent));
      continue;
    }
    const data = { ...(it.data ?? {}) };
    delete data.title;
    delete data.isVault;
    if (data.isEncrypted === false) delete data.isEncrypted;
    // T5: la push manda comunque la riga (planVaultNotePush); col content allineato reactivates riconosce un payload gia' provato
    if (gated && 'content' in data) data.content = rowContent;
    if (Object.keys(data).length === 0) await db.syncQueue.delete(it.id as number);
    else await requeue(it.id, data);
  }
  return n;
}

/** Item della nota dopo che la riga ha preso il contenuto del server: CREATE superflui via, solo content/title/isEncrypted via, misti ripuliti. */
async function settleItems(userId: string, id: string) {
  for (const it of await noteItems(userId, id)) {
    if (it.type === 'DELETE') continue;
    const rest = Object.keys(it.data ?? {}).filter((k) => !STRIP_KEYS.has(k));
    if (it.type === 'CREATE' || rest.length === 0) await db.syncQueue.delete(it.id as number);
    else await requeue(it.id, Object.fromEntries(rest.map((k) => [k, (it.data as Record<string, unknown>)[k]])));
  }
}

async function addCopy(c: CopySpec, userId: string) {
  const now = new Date().toISOString();
  await db.notes.add({
    id: c.id, title: c.title, content: c.content, notebookId: c.notebookId, userId, isTrashed: false,
    createdAt: now, updatedAt: now, tags: [], attachments: [], isVault: c.vault, isEncrypted: c.vault,
    noteType: c.noteType, ownership: 'owned', sharedPermission: null, sharedByUser: null, syncStatus: 'created',
  } as LocalNote);
  await db.syncQueue.add({
    type: 'CREATE', entity: 'NOTE', entityId: c.id, userId, createdAt: Date.now(),
    data: c.vault
      ? { title: '', notebookId: c.notebookId, content: c.content, isVault: true, isEncrypted: true, noteType: c.noteType, id: c.id }
      : { id: c.id, title: c.title, content: c.content, notebookId: c.notebookId, noteType: c.noteType },
  });
}

async function dropItems(userId: string, id: string) {
  for (const it of await noteItems(userId, id)) await db.syncQueue.delete(it.id as number);
}

async function commit(s: Snapshot, d: Decision, plan: Plan): Promise<{ ok: boolean; reactivated: number }> {
  const { id, userId } = s;
  let reactivated = 0;
  const ok = await db.transaction('rw', db.notes, db.syncQueue, async () => {
    const row = await db.notes.get(id);
    const items = await noteItems(userId, id);
    if (sigOf(row, items) !== s.sig) return false; // precondizione 7: lo snapshot e' cambiato
    if (s.listed !== undefined && listSig(row, items) !== s.listed) return false; // ... o lo e' dal listing: il server in mano e' vecchio
    const sv = s.srv.k === 'item' ? s.srv.item : undefined;
    if (plan.copy) await addCopy(plan.copy, userId);
    switch (d.op) {
      case 'HYDRATE':
        await db.notes.update(id, { content: sv!.content, title: sv!.title, isEncrypted: true, vaultBaseHash: s.hs, vaultSentHashes: [], updatedAt: sv!.updatedAt });
        break;
      case 'ACK':
        await db.notes.update(id, { vaultBaseHash: s.hs });
        await requeueVault(userId, id, row!.content);
        break;
      case 'REQUEUE':
        await requeueVault(userId, id, row!.content);
        break;
      case 'STRIP_REQUEUE':
        reactivated = await requeueVault(userId, id, row!.content, true);
        break;
      case 'SYNC':
        await db.notes.update(id, {
          vaultBaseHash: s.hs, vaultSentHashes: [],
          ...(items.some((i) => i.type !== 'DELETE') ? {} : { syncStatus: 'synced' as const }),
        });
        break;
      case 'QUEUE_CONTENT':
        if (row!.vaultBaseHash !== s.hs) await db.notes.update(id, { vaultBaseHash: s.hs });
        if (!items.some((i) => i.type === 'CREATE' || (!!i.data && 'content' in i.data))) {
          await db.syncQueue.add({ type: 'UPDATE', entity: 'NOTE', entityId: id, userId, createdAt: Date.now(), data: { content: row!.content } });
        }
        break;
      case 'ADOPT':
        await db.notes.update(id, {
          content: sv!.content, title: sv!.title, vaultBaseHash: s.hs, vaultSentHashes: [], updatedAt: sv!.updatedAt,
          syncStatus: 'synced', isVault: true, noteType: sv!.noteType, ...(isEnv(sv!.content) ? { isEncrypted: true } : {}),
        });
        await settleItems(userId, id);
        break;
      case 'REENCRYPT_TITLE': {
        // Titolo nuovo dentro l'envelope: la riga e' ora piu' recente del server, la base CAS resta e l'UPDATE{content} la porta.
        const env = plan.env!;
        await db.notes.update(id, { content: env, title: '', isEncrypted: true, syncStatus: 'updated', updatedAt: new Date().toISOString() });
        for (const it of items) {
          if (it.type === 'DELETE') continue;
          const rest = Object.keys(it.data ?? {}).filter((k) => k !== 'title');
          if (it.type !== 'CREATE' && rest.length === 0) await db.syncQueue.delete(it.id as number);
          else if (it.type === 'CREATE') await requeue(it.id, canonicalCreateData(it.data, env));
          else await requeue(it.id, Object.fromEntries(rest.map((k) => [k, (it.data as Record<string, unknown>)[k]])));
        }
        await db.syncQueue.add({ type: 'UPDATE', entity: 'NOTE', entityId: id, userId, createdAt: Date.now(), data: { content: env } });
        break;
      }
      case 'STRIP_CONTENT':
        // Content in chiaro stantio su riga gia' envelope: torna all'envelope della riga (la push usa quello di Dexie).
        for (const it of items) {
          if (it.type === 'DELETE' || !hasPlainContent(it)) continue;
          await requeue(it.id, { ...(it.data ?? {}), content: row!.content, ...(it.type === 'CREATE' ? { title: '' } : {}) });
        }
        break;
      case 'REENCRYPT_CREATE': {
        // CREATE mai arrivata: ri-cifratura sul posto (stesso id) e CREATE rinfrescata.
        const env = plan.env!;
        await db.notes.update(id, { content: env, title: '', isEncrypted: true, vaultBaseHash: undefined, vaultSentHashes: [] });
        for (const it of items) {
          if (it.type === 'DELETE') continue;
          if (it.type === 'CREATE') {
            await requeue(it.id, canonicalCreateData(it.data, env));
            continue;
          }
          const rest = Object.keys(it.data ?? {}).filter((k) => !STRIP_KEYS.has(k));
          if (rest.length === 0) await db.syncQueue.delete(it.id as number);
          else await requeue(it.id, Object.fromEntries(rest.map((k) => [k, (it.data as Record<string, unknown>)[k]])));
        }
        break;
      }
      case 'REFRESH_CREATE':
        for (const it of items) {
          if (it.type === 'CREATE') await requeue(it.id, canonicalCreateData(it.data, row!.content));
        }
        await requeueVault(userId, id, row!.content);
        break;
      case 'DROP':
        await dropItems(userId, id);
        await db.notes.delete(id);
        break;
      case 'UNVAULT':
        // Nota non vault con errori vault: l'item diventa normale (vince l'ultimo che scrive).
        for (const it of items) {
          if (!vaultFailed(it)) continue;
          const data = { ...(it.data ?? {}) };
          delete data.isVault;
          delete data.isEncrypted;
          // L'envelope del payload torna al content della riga; riga non caricata (''): niente content, un PUT con '' cancellerebbe il testo del server.
          if (typeof data.content === 'string' && isEnv(data.content)) {
            if (row!.content === '') delete data.content;
            else data.content = row!.content;
          }
          if (Object.keys(data).length === 0) await db.syncQueue.delete(it.id as number);
          else await requeue(it.id, data);
        }
        break;
      case 'DROP_ITEMS':
        await dropItems(userId, id);
        break;
      default:
        break;
    }
    return true;
  });
  return { ok, reactivated };
}

// ---------------------------------------------------------------------------------------------------------------------
// Idratazione di una nota (T1) all'apertura
// ---------------------------------------------------------------------------------------------------------------------

/** All'apertura di una nota, prima del mount dell'editor (che tiene il lock della nota: qui non lo si chiede). Solo T1:
 *  riga synced (o content '') dell'utente collegato il cui hash differisce dalla base. */
export async function hydrateVaultNote(id: string): Promise<boolean> {
  const userId = useAuthStore.getState().user?.id;
  const epoch = useVaultStore.getState().epoch;
  // Stato della riga prima della GET: una push (o un'altra scheda) che chiude fra la GET e la transazione lo cambia, e l'envelope letto e' vecchio.
  const before = await db.notes.get(id);
  if (!before) return false;
  const sv = (await getItems<ItemsPage>({ ids: [id] })).items.find((i) => i.id === id);
  // un content non envelope e' del wizard di migrazione, uno di un altro epoch di P3
  if (!userId || epoch == null || !sv || !isCurrentEnvelope(sv.content, epoch)) return false;
  const hs = await sha256hex(sv.content);
  return db.transaction('rw', db.notes, async () => {
    const cur = await db.notes.get(id);
    if (!cur || !cur.isVault || cur.userId !== userId || cur.ownership === 'shared') return false; // una riga non vault (LN) e' di T12-T14
    if (cur.vaultBaseHash !== before.vaultBaseHash || cur.updatedAt !== before.updatedAt || cur.syncStatus !== before.syncStatus) return false;
    if (!(cur.syncStatus === 'synced' || cur.content === '') || (cur.content !== '' && hs === cur.vaultBaseHash)) return false;
    await db.notes.update(id, { content: sv.content, title: sv.title, isEncrypted: true, vaultBaseHash: hs, vaultSentHashes: [], updatedAt: sv.updatedAt });
    return true;
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Giro
// ---------------------------------------------------------------------------------------------------------------------

let inflight: Promise<ReconcileResult> | null = null;
/** Il giro in coda: uno solo, condiviso da tutte le chiamate arrivate mentre ne girava un altro. */
let queued: { p: Promise<ReconcileResult>; opts: ReconcileOptions; go: (r: Promise<ReconcileResult>) => void } | null = null;

function start(opts: ReconcileOptions): Promise<ReconcileResult> {
  // Passaggio di mano atomico: nello stesso callback il giro finito si toglie e quello in coda diventa `inflight`, senza un punto in cui
  // una chiamata nuova veda `inflight` vuoto e parta in parallelo.
  const p = run(opts).finally(() => {
    inflight = null;
    const q = queued;
    queued = null;
    if (q) q.go(start(q.opts));
  });
  inflight = p;
  return p;
}

/** Giro completo (plan 5.8). Un solo giro alla volta per scheda: al massimo 1 in volo e 1 in coda. Una chiamata durante un giro NON ne condivide
 *  il risultato (il giro in volo ha gia' letto il listing: un trigger arrivato dopo deve vedere lo stato nuovo) ma accoda un giro successivo;
 *  piu' chiamate collassano nello stesso giro in coda, che usa il decryptLegacy della prima chiamata che lo porta. Fra schede il lock del giro
 *  e' in attesa: nessun trigger si perde. */
export function vaultReconcile(opts: ReconcileOptions = {}): Promise<ReconcileResult> {
  if (!inflight) return start(opts);
  // Il signal e' del chiamante, non del giro condiviso (che serve anche gli altri): qui si stacca solo questo chiamante, con busy.
  const shared: ReconcileOptions = { ...opts, signal: undefined };
  if (queued) {
    // ponytail: piu' chiamate legacy accodate condividono il primo decryptLegacy (e' il callback della stessa sessione di migrazione).
    if (opts.decryptLegacy && !queued.opts.decryptLegacy) queued.opts = shared;
    return abortable(queued.p, opts.signal);
  }
  let go!: (r: Promise<ReconcileResult>) => void;
  const p = new Promise<ReconcileResult>((resolve) => { go = resolve; });
  queued = { p, opts: shared, go };
  return abortable(p, opts.signal);
}

/** Race fra il giro in coda e l'abort di UN chiamante: l'abort risolve solo lui con busy, il giro continua per gli altri. */
function abortable(p: Promise<ReconcileResult>, signal?: AbortSignal): Promise<ReconcileResult> {
  if (!signal) return p;
  const busy = { ...emptyResult(), skipped: 'busy' as const };
  if (signal.aborted) return Promise.resolve(busy);
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(busy);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

const emptyResult = (): ReconcileResult =>
  ({ hydrated: 0, conflictsResolved: 0, copies: 0, legacyResolved: 0, reactivated: 0, finalized: 0, legacyLeft: 0, unresolved: 0, later: 0, legacyPin: 0 });

async function run(opts: ReconcileOptions): Promise<ReconcileResult> {
  const r = emptyResult();
  const userId = useAuthStore.getState().user?.id;
  const vs = useVaultStore.getState();
  const keys = userId ? vs.getKeysFor(userId) : null;
  if (!userId || !keys || vs.epoch == null) return { ...r, skipped: 'locked' };
  const cache = vs.byUser[userId];
  if (cache?.status !== 'READY' || cache.epoch !== vs.epoch) return { ...r, skipped: 'notReady' };
  const ctx: VaultCodecCtx = { keys, userId, epoch: vs.epoch };
  const out = await withReconcileLock(() => round(ctx, opts, r), opts.signal);
  if (out.status === 'busy') return { ...r, skipped: 'busy' };
  return out.status === 'ran' ? out.value : round(ctx, opts, r); // senza navigator.locks il giro gira lo stesso (le note: solo op sicure)
}

/** `listed` = firma di riga e item quando e' stato preso il listing (listSig): se al momento di lavorare la nota e' diversa, il server che
 *  abbiamo in mano e' piu' vecchio della nota (una push o un'altra scheda hanno scritto dopo) -> LATER. */
interface Candidate { id: string; row?: LocalNote; items: SyncQueueItem[]; listed: string }

async function lookup(ids: string[], live: () => boolean): Promise<Map<string, Srv>> {
  const out = new Map<string, Srv>();
  for (let i = 0; i < ids.length && live(); i += IDS_CHUNK) {
    const chunk = ids.slice(i, i + IDS_CHUNK);
    let page: ItemsPage | undefined;
    try {
      page = await getItems<ItemsPage>({ ids: chunk });
    } catch {
      /* rete, 5xx, 429: S? per tutto il blocco, mai "assente" */
    }
    const found = new Map((page?.items ?? []).map((it) => [it.id, it]));
    for (const id of chunk) {
      const it = found.get(id);
      if (it) out.set(id, { k: 'item', item: it });
      else if (page?.absent?.includes(id)) out.set(id, { k: 'S0' });
      else if (page?.notVault?.includes(id)) out.set(id, { k: 'SN' });
      else out.set(id, { k: 'unknown' });
    }
  }
  return out;
}

async function round(ctx: VaultCodecCtx, opts: ReconcileOptions, r: ReconcileResult): Promise<ReconcileResult> {
  const { userId } = ctx;
  const keys = ctx.keys;
  const live = () => useVaultStore.getState().keys === keys;
  const abort = (): ReconcileResult => ({ ...r, aborted: true });
  if (!live()) return abort();

  // 0. La coda si legge PRIMA del listing: una push che finisce mentre si chiede il server cancella i suoi item, e la nota risulta cambiata.
  const queue = await noteItems(userId);

  // 1. Listing completo paginato: serve a T1, a legacyLeft e a finalize.
  const listing = new Map<string, ServerItem>();
  const toFinalize: ServerItem[] = [];
  let after: string | undefined;
  do {
    const page = await getItems<ItemsPage>(after ? { after } : {});
    if (!live()) return abort();
    for (const s of page.items) {
      listing.set(s.id, s);
      if (!isCurrentEnvelope(s.content, ctx.epoch)) r.legacyLeft++;
      else if (s.hasPlaintextVersions) toFinalize.push(s);
    }
    after = page.next ?? undefined;
  } while (after);

  // 2. Candidati: id del listing con una riga locale, id con item di coda rilevanti. Z, QD e i no-op certi escono qui, senza lock.
  const queueById = new Map<string, SyncQueueItem[]>();
  for (const it of queue) queueById.set(it.entityId, [...(queueById.get(it.entityId) ?? []), it]);
  const ids = [...new Set([...listing.keys(), ...queueById.keys()])];
  const rows = await db.notes.bulkGet(ids);
  const cands: Candidate[] = [];
  ids.forEach((id, k) => {
    const row = rows[k];
    const items = queueById.get(id) ?? [];
    if (items.some((i) => i.type === 'DELETE')) return;
    if (row) {
      if (row.userId !== userId || row.ownership === 'shared') return;
      if (!(listing.has(id) || row.isVault || items.some(vaultFailed) || isEnv(row.content))) return;
      const sv = listing.get(id);
      if (sv && !items.length && row.isVault && row.syncStatus === 'synced' && row.title === '' && isEnv(row.content) && row.vaultBaseHash === sv.contentHash) return;
    } else if (!items.some(vaultFailed)) return;
    cands.push({ id, row, items, listed: listSig(row, items) });
  });
  const srvOf = await lookup(cands.filter((c) => c.row && !listing.has(c.id)).map((c) => c.id), live);
  if (!live()) return abort();

  // 3. Una nota alla volta, sotto il suo lock.
  for (const c of cands) {
    if (!live()) return abort();
    const sv = listing.get(c.id);
    const srv: Srv = sv ? { k: 'item', item: sv } : srvOf.get(c.id) ?? { k: 'unknown' };
    try {
      await processNote(c, srv, ctx, opts, r);
    } catch (e) {
      r.unresolved++;
      console.warn('[vaultReconcile] nota lasciata invariata:', c.id, (e as Error)?.name, (e as Error)?.message); // mai contenuto
    }
  }

  // 4. finalize: solo con decifratura e validazione strutturale riuscite (5.8.5).
  const valid: string[] = [];
  for (const s of toFinalize) {
    if (!live()) return abort();
    try {
      const { c } = await decryptItem(s.id, s.noteType, s.content, ctx);
      const body = JSON.parse(c);
      const ok = s.noteType === 'NOTE'
        ? body?.type === 'doc'
        : typeof body === 'object' && body !== null && !Array.isArray(body);
      if (ok) valid.push(s.id);
    } catch {
      /* non decifrabile o non valido: le versioni in chiaro restano */
    }
  }
  for (let i = 0; i < valid.length; i += FINALIZE_CHUNK) {
    if (!live()) return abort();
    const chunk = valid.slice(i, i + FINALIZE_CHUNK);
    const res = await finalizeItems<{ finalized?: number }>(chunk);
    r.finalized += res?.finalized ?? chunk.length;
  }
  return r;
}

async function processNote(c: Candidate, srv: Srv, ctx: VaultCodecCtx, opts: ReconcileOptions, r: ReconcileResult) {
  const { id } = c;
  const later = () => { r.later++; r.unresolved++; };
  const attempt = async (lock: 'held' | 'none') => {
    const row = await db.notes.get(id);
    const items = await noteItems(ctx.userId, id);
    let snap: Snapshot = { id, userId: ctx.userId, epoch: ctx.epoch, k: true, lock, row, items, srv, sig: sigOf(row, items), listed: c.listed };
    let d = decide(snap);
    // Il server in mano e' del listing: se da allora la nota e' cambiata (push 2xx, altra scheda) ogni op che scrive userebbe un envelope vecchio.
    if (d.op !== 'NONE' && d.op !== 'SKIP' && listSig(row, items) !== c.listed) return later();
    if (!['P1', 'P2', 'P3', 'P4', 'P6'].includes(d.rule)) {
      snap = await withFacts(snap, ctx, opts);
      d = decide(snap);
    }
    if (d.op === 'NONE' || d.op === 'SKIP') return;
    if (d.op === 'LATER') return later();
    if (d.op === 'LEAVE') {
      r.unresolved++;
      if (d.why === 'legacyPin' && snap.row) r.legacyPin++; // T15 (senza riga) non conta: decryptLegacy lavora sulle righe
      return;
    }
    const prepared = await prepare(snap, d, ctx);
    if ('leave' in prepared) {
      r.unresolved++;
      return;
    }
    const res = await commit(snap, d, prepared.plan);
    if (!res.ok) return later();
    if (d.op === 'HYDRATE') r.hydrated++;
    else if (d.op === 'STRIP_REQUEUE') r.reactivated += res.reactivated;
    else if (['T6', 'T7', 'T9'].includes(d.rule)) r.legacyResolved++;
    else r.conflictsResolved++;
    if (d.copy) r.copies++;
  };
  if (!hasLocks()) return attempt('none');
  // Exclusive + ifAvailable: escluso sia dall'editor aperto (lock shared) sia da una push in corso (shared); il commit non aspetta mai.
  const res = await withNoteLock(id, () => attempt('held'), { ifAvailable: true, mode: 'exclusive' });
  if (res.status === 'busy') return later();
  if (res.status === 'nolocks') return attempt('none');
}
