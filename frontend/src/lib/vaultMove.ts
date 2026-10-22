import api from './api';
import { db } from './db';
import { sha256hex } from '../utils/vaultCrypto';
import { useVaultStore } from '../store/vaultStore';
import * as vaultApi from './vaultApi';
import { decryptItem, encryptItem, VaultLockedError } from './vaultCodec';
import type { ServerItem } from './vaultReconcile';

// Vault v3 (T18, T21): spostamento FUORI (moveOut) e DENTRO (moveIn) il vault (plan 5.9). Solo online, chiamata REST diretta:
// niente syncQueue, perche' il plaintext non deve mai restare in coda. Il codice sta in lib/ per non importare fra cartelle features.

export type VaultMoveCode = 'offline' | 'conflict' | 'notReady' | 'failed' | 'attachmentsBlocked' | 'locked' | 'pending' | 'failedQueued';

export class VaultMoveError extends Error {
  code: VaultMoveCode;
  constructor(code: VaultMoveCode) {
    super(`vault.move.${code}`);
    this.name = 'VaultMoveError';
    this.code = code;
  }
}

const codeOf = (err: unknown): VaultMoveCode => {
  const r = (err as { response?: { status?: number; data?: { message?: string } } } | undefined)?.response;
  if (!r) return 'offline'; // nessuna risposta: rete assente o timeout
  const m = r.data?.message;
  if (r.status === 422 && m === 'errors.vault.conflict') return 'conflict';
  if (r.status === 422 && m === 'errors.vault.notReady') return 'notReady';
  if (r.status === 422 && m === 'errors.vault.attachmentsBlocked') return 'attachmentsBlocked';
  return 'failed';
};

const VAULT_PAYLOAD_KEYS = new Set(['content', 'title', 'isEncrypted']);

// Stato di spostamento IN a livello di modulo (T21): sopravvive allo smontaggio dell'editor. Una nuova istanza (cambio nota e ritorno
// durante lo spostamento) lo legge e resta in sola lettura. Contatore per id: il chiamante e moveIn possono annidarsi.
const movingIn = new Map<string, number>();
const movingListeners = new Set<() => void>();
export const isMovingIn = (id: string): boolean => movingIn.has(id);
export function subscribeMovingIn(listener: () => void): () => void {
  movingListeners.add(listener);
  return () => { movingListeners.delete(listener); };
}
export function beginMovingIn(id: string): () => void {
  movingIn.set(id, (movingIn.get(id) ?? 0) + 1);
  movingListeners.forEach((l) => l());
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (movingIn.get(id) ?? 1) - 1;
    if (n > 0) movingIn.set(id, n);
    else movingIn.delete(id);
    movingListeners.forEach((l) => l());
  };
}

/**
 * Item NOTE in coda della nota (non DELETE) ripuliti dal payload vault: quelli fatti solo di content/title/isEncrypted
 * (envelope o testo vecchi, spediti dopo riscriverebbero la nota) e le CREATE (la nota esiste gia' sul server: replay)
 * si cancellano; gli item misti (es. {isPinned}) restano in coda (pending) senza quelle chiavi. Ritorna quanti item restano.
 * Da chiamare dentro una transazione rw su syncQueue.
 */
async function stripQueuedVaultPayload(id: string): Promise<number> {
  const queued = await db.syncQueue.filter((q) => q.entity === 'NOTE' && q.entityId === id && q.type !== 'DELETE').toArray();
  const drop: number[] = [];
  let remaining = 0;
  for (const q of queued) {
    const rest = Object.fromEntries(Object.entries(q.data ?? {}).filter(([k]) => !VAULT_PAYLOAD_KEYS.has(k)));
    if (q.type === 'CREATE' || Object.keys(rest).length === 0) {
      drop.push(q.id as number);
    } else {
      remaining++;
      if (Object.keys(rest).length !== Object.keys(q.data ?? {}).length) {
        await db.syncQueue.update(q.id as number, { data: rest, status: 'pending', attempts: 0, lastError: undefined });
      }
    }
  }
  await db.syncQueue.bulkDelete(drop);
  return remaining;
}

/**
 * Toglie una nota dal vault: `PUT {isVault:false, isEncrypted:false, content: c, title: t, baseHash}`.
 * `baseHash` = hash dell'ultimo content visto dal server (`vaultBaseHash`; per una riga legacy in chiaro, l'hash del content locale).
 * Su 200: PRIMA `onCommitted` (chiude l'editor), POI la riga Dexie in chiaro senza base e gli item in coda della nota
 * (envelope vecchi che, spediti dopo, riscriverebbero la nota in chiaro con un envelope). Lancia `VaultMoveError`.
 */
export async function moveOut(id: string, args: { title: string; content: string; onCommitted?: () => void }): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new VaultMoveError('offline');
  const row = await db.notes.get(id);
  if (!row) throw new VaultMoveError('failed');
  const baseHash = row.vaultBaseHash ?? (await sha256hex(row.content ?? ''));
  let updatedAt: string | undefined;
  try {
    const res = await api.put(`/notes/${id}`, { isVault: false, isEncrypted: false, content: args.content, title: args.title, baseHash });
    updatedAt = (res?.data as { updatedAt?: string } | undefined)?.updatedAt;
  } catch (e) {
    throw new VaultMoveError(codeOf(e));
  }
  // Punto di non ritorno: la PUT e' andata. Un errore qui sotto non e' un fallimento dello spostamento (la nota e' gia' in chiaro
  // sul server): niente throw, cosi' il chiamante non mostra 'failed' ne' riaccoda un envelope su una nota non piu' vault (422). La pull riallinea.
  try {
    args.onCommitted?.();
    await db.transaction('rw', db.notes, db.syncQueue, async () => {
      const remaining = await stripQueuedVaultPayload(id);
      await db.notes.update(id, {
        isVault: false,
        isEncrypted: false,
        title: args.title,
        content: args.content,
        vaultBaseHash: undefined,
        vaultSentHashes: undefined,
        syncStatus: remaining === 0 ? 'synced' : 'updated',
        ...(updatedAt ? { updatedAt } : {}),
      });
    });
  } catch (e) {
    console.error('vault moveOut: scrittura locale dopo la PUT non riuscita', e);
  }
}

// ---------------------------------------------------------------- ingresso (T21)

export type VaultEntryState = 'ready' | 'locked' | 'setup';

/**
 * Passo 0 del piano 5.9. 'ready' = chiavi dell'utente in memoria; 'locked' = keyring READY da sbloccare (dialog di PIN);
 * 'setup' = NONE (con o senza legacy), RESET_PENDING, GET fallita (UNKNOWN) o setup disabilitato: l'UI va a /vault, mai una PUT.
 */
export async function vaultEntryState(userId: string): Promise<VaultEntryState> {
  const s = useVaultStore.getState();
  if (s.keys && s.unlockedUserId === userId && s.epoch != null) return 'ready';
  if (s.byUser[userId]?.status === 'READY') return 'locked';
  try {
    return (await vaultApi.getKeyring<{ status?: string }>()).status === 'READY' ? 'locked' : 'setup';
  } catch {
    return 'setup';
  }
}

const PENDING_WAIT_MS = 5000;
const PENDING_POLL_MS = 200;
const MAX_CONFLICT_RETRIES = 2;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Zero item in coda per la nota (non DELETE): altrimenti il testo digitato non e' ancora sul server e la GET lo perderebbe.
 * Gli item `failed` (413/422 deterministici) non si svuotano da soli: se restano SOLO quelli l'errore e' subito 'failedQueued'
 * (l'utente deve sistemare la sync), non un 'pending' dopo 5 s.
 */
async function waitNoPending(id: string): Promise<void> {
  const end = Date.now() + PENDING_WAIT_MS;
  const mine = (q: { entity: string; entityId: string; type: string }) => q.entity === 'NOTE' && q.entityId === id && q.type !== 'DELETE';
  for (;;) {
    const live = await db.syncQueue.filter((q) => mine(q) && q.status !== 'failed').primaryKeys();
    if (live.length === 0) {
      const failed = await db.syncQueue.filter((q) => mine(q) && q.status === 'failed').primaryKeys();
      if (failed.length > 0) throw new VaultMoveError('failedQueued');
      return;
    }
    if (Date.now() >= end) throw new VaultMoveError('pending');
    await sleep(PENDING_POLL_MS);
  }
}

/**
 * Mette una nota normale nel vault. Il chiamante ha gia' fermato i salvataggi dell'editor, fatto il flush del testo e `syncPush()`.
 * Passi: coda vuota -> GET (mai dalla cache SW) -> envelope + round-trip -> `beforePut` (revoca condivisioni, una volta sola) ->
 * `PUT {isVault:true, content: env, title:'', baseHash}` diretta. 422 conflict: si riparte dalla GET (al massimo 2 volte).
 * Su 200: PRIMA `onCommitted` (chiude l'editor), POI la riga Dexie (envelope, titolo '') e la coda della nota si ripulisce;
 * infine finalize best-effort (se salta lo riprende il reconcile). Lancia `VaultMoveError`.
 */
export async function moveIn(id: string, args: { beforePut?: () => Promise<void>; onCommitted?: () => void } = {}): Promise<void> {
  const end = beginMovingIn(id); // fino alla fine (anche su errore) le istanze dell'editor di questa nota restano in sola lettura
  try {
    await moveInUnguarded(id, args);
  } finally {
    end();
  }
}

async function moveInUnguarded(id: string, args: { beforePut?: () => Promise<void>; onCommitted?: () => void }): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new VaultMoveError('offline');
  if (!useVaultStore.getState().keys) throw new VaultMoveError('locked');
  await waitNoPending(id);
  let beforePutDone = false;
  for (let attempt = 0; ; attempt++) {
    let server: { title?: string; content?: string; attachments?: unknown[]; isVault?: boolean };
    try {
      server = (await api.get(`/notes/${id}`)).data;
    } catch (e) {
      throw new VaultMoveError(codeOf(e));
    }
    if (server.attachments?.length) throw new VaultMoveError('attachmentsBlocked');
    if (server.isVault || typeof server.content !== 'string') throw new VaultMoveError('failed');
    const item = { t: server.title ?? '', c: server.content };
    let env: string;
    try {
      env = await encryptItem(id, 'NOTE', item);
      const back = await decryptItem(id, 'NOTE', env); // round-trip in memoria prima della PUT
      if (back.t !== item.t || back.c !== item.c) throw new VaultMoveError('failed');
    } catch (e) {
      if (e instanceof VaultMoveError) throw e;
      throw new VaultMoveError(e instanceof VaultLockedError ? 'locked' : 'failed');
    }
    if (!beforePutDone) {
      beforePutDone = true;
      try {
        await args.beforePut?.();
      } catch {
        throw new VaultMoveError('failed');
      }
    }
    const baseHash = await sha256hex(server.content);
    let updatedAt: string | undefined;
    try {
      const res = await api.put(`/notes/${id}`, { isVault: true, content: env, title: '', baseHash });
      updatedAt = (res?.data as { updatedAt?: string } | undefined)?.updatedAt;
    } catch (e) {
      const code = codeOf(e);
      if (code === 'conflict' && attempt < MAX_CONFLICT_RETRIES) continue;
      throw new VaultMoveError(code);
    }
    // Punto di non ritorno: la PUT e' andata. Un errore qui sotto non e' un fallimento dello spostamento (la nota e' gia' nel vault
    // sul server): niente throw, cosi' il chiamante non mostra 'failed' ne' riaccoda testo in chiaro. La pull riallinea la riga locale.
    try {
      args.onCommitted?.();
      const envHash = await sha256hex(env);
      await db.transaction('rw', db.notes, db.syncQueue, async () => {
        // item in coda col testo in chiaro (UPDATE tardivi): spediti dopo riscriverebbero la nota vault; i metadati ({isPinned}...) restano
        const remaining = await stripQueuedVaultPayload(id);
        await db.notes.update(id, {
          isVault: true,
          isEncrypted: true,
          isPublic: false,
          sharedWith: [], // condivisioni revocate da beforePut: fino alla pull non devono restare nella riga
          shareId: null,
          title: '',
          searchText: '', // testo in chiaro della ricerca offline: mai nel vault (D8)
          content: env,
          vaultBaseHash: envHash,
          vaultSentHashes: [],
          syncStatus: remaining === 0 ? 'synced' : 'updated',
          ...(updatedAt ? { updatedAt } : {}),
        });
      });
    } catch (e) {
      console.error('vault moveIn: scrittura locale dopo la PUT non riuscita', e);
      return;
    }
    try {
      const sv = (await vaultApi.getItems<{ items: ServerItem[] }>({ ids: [id] })).items.find((i) => i.id === id);
      if (sv) {
        const back = await decryptItem(id, 'NOTE', sv.content);
        if (back.t === item.t && back.c === item.c) await vaultApi.finalizeItems([id]);
      }
    } catch {
      // la nota e' gia' nel vault: il reconcile riprende il finalize (plan 5.8)
    }
    return;
  }
}
