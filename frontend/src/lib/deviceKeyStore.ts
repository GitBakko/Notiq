// Vault v3: chiave del dispositivo, share cifrato e marker pending. IndexedDB raw `notiq-vault-device`
// (NON Dexie, NON lib/db.ts): nessuna versione Dexie da toccare. Nessun segreto in chiaro: la chiave e'
// non-extractable, lo share e' cifrato con essa, i marker contengono solo hash e numeri (mai authKey, PIN o payload).
import { generateDeviceKey } from '../utils/vaultCrypto';

const DB_NAME = 'notiq-vault-device';
const DB_VERSION = 1;
const KEYS = 'deviceKeys';
const SHARES = 'shares';
const PENDING = 'pending';

/** shareEnc = AES-GCM(devKey, serverShare, AAD device|userId|epoch). wrappedVkSigKey: serve allo sblocco offline (VaultKeys.sigKey). */
export interface DeviceShare {
  epoch: number;
  shareEnc: Uint8Array;
  wrappedVkSigKey: Uint8Array;
}

/**
 * Marker `kit`: uno per escrow (chiave `<userId>:kit:<escrowHash>`), valore immutabile scritto con `add`. `(epoch, rev)` sono quelli del keyring su cui si e' costruita la richiesta
 * (rev null = setup, che committa solo da status NONE). Solo hash, numeri, origin e requestId: mai segreti. `confirmed`/`createdAt` esistono solo nello slot legacy P2 `<userId>:kit` (mai scritto).
 */
export interface KitMarker {
  kind: 'kit';
  escrowHash: string;
  epoch: number;
  rev: number | null;
  origin: 'setup' | 'regenerate' | 'recovery';
  requestId?: string;
  confirmed?: false;
  createdAt?: number;
}
/** `epoch` assente nei marker scritti dalla P2 (1.14.0): per quelli decide solo la rev. */
export interface PinMarker { kind: 'pin'; rev: number; epoch?: number; wrappedVkPinHash: string }
export type PendingMarker = KitMarker | PinMarker;

/** Chiave ECDH effimera della richiesta di recupero (privata non-extractable). requestId null finche' la POST non ha risposto; createdAt (ms) data la grazia delle chiavi orfane. */
export interface RecoveryKey {
  requestId: string | null;
  privateKey: CryptoKey;
  publicRaw: Uint8Array;
  createdAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const p = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('indexedDBUnavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of [KEYS, SHARES, PENDING]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // un upgrade da un'altra scheda non deve restare bloccato da questa connessione
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('indexedDBOpenFailed'));
    // onblocked non rifiuta: l'apertura prosegue (onsuccess) appena l'altra scheda chiude, oppure fallisce con onerror
  });
  // un'apertura fallita non resta in cache: la chiamata seguente riprova
  dbPromise = p;
  p.catch(() => {
    if (dbPromise === p) dbPromise = null;
  });
  return p;
}

async function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    let result: T;
    req.onsuccess = () => {
      result = req.result;
    };
    // si risolve a transazione completata (durabilita' dello store)
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error ?? req.error ?? new Error('indexedDBFailed'));
    tx.onabort = () => reject(tx.error ?? new Error('indexedDBAborted'));
  });
}

// marker pin a slot unico (compare-and-delete per hash); marker kit uno per escrow: il range copre solo `<userId>:kit:` (lo slot legacy `<userId>:kit` e' fuori, e u1 non cattura u10)
const pinKey = (userId: string) => `${userId}:pin`;
const legacyKitKey = (userId: string) => `${userId}:kit`;
const kitKey = (userId: string, escrowHash: string) => `${userId}:kit:${escrowHash}`;
const kitRange = (userId: string) => IDBKeyRange.bound(`${userId}:kit:`, `${userId}:kit:￿`);

const get = <T>(store: string, userId: string) => run<T | undefined>(store, 'readonly', (s) => s.get(userId));
const put = (store: string, userId: string, value: unknown) => run(store, 'readwrite', (s) => s.put(value, userId));
const add = (store: string, userId: string, value: unknown) => run(store, 'readwrite', (s) => s.add(value, userId));
const del = (store: string, userId: string) => run(store, 'readwrite', (s) => s.delete(userId));

export async function getDeviceKey(userId: string): Promise<CryptoKey | null> {
  return (await get<CryptoKey>(KEYS, userId)) ?? null;
}

/** Crea e salva la chiave AES-GCM non-extractable del dispositivo se manca. */
export async function getOrCreateDeviceKey(userId: string): Promise<CryptoKey> {
  const cur = await getDeviceKey(userId);
  if (cur) return cur;
  const key = await generateDeviceKey();
  try {
    await add(KEYS, userId, key); // add, non put: due schede non si sovrascrivono la chiave
    return key;
  } catch (e) {
    const winner = await getDeviceKey(userId).catch(() => null); // ConstraintError: vince la chiave gia' salvata
    if (winner) return winner;
    throw e;
  }
}

export async function getShare(userId: string): Promise<DeviceShare | null> {
  return (await get<DeviceShare>(SHARES, userId)) ?? null;
}

export const putShare = (userId: string, share: DeviceShare) => put(SHARES, userId, share).then(() => undefined);

export const deleteShare = (userId: string) => del(SHARES, userId).then(() => undefined);

export async function getPending(userId: string, _kind: 'pin'): Promise<PinMarker | null> {
  return (await get<PinMarker>(PENDING, pinKey(userId))) ?? null;
}

export const setPending = (userId: string, marker: PinMarker) => put(PENDING, pinKey(userId), marker).then(() => undefined);

export const clearPending = (userId: string, _kind: 'pin') => del(PENDING, pinKey(userId)).then(() => undefined);

/** Compare-and-delete del marker pin in UNA transazione: solo se ha ancora quell'hash del wrap. true = cancellato, false = assente o cambiato (lo ha gia' risolto un'altra chiamata). */
export async function clearPinMarkerIf(userId: string, wrappedVkPinHash: string): Promise<boolean> {
  const db = await openDb();
  return new Promise<boolean>((resolve, reject) => {
    const tx = db.transaction(PENDING, 'readwrite');
    const s = tx.objectStore(PENDING);
    const key = pinKey(userId);
    let hit = false;
    const req = s.get(key);
    req.onsuccess = () => {
      const cur = req.result as PinMarker | undefined;
      if (cur?.kind === 'pin' && cur.wrappedVkPinHash === wrappedVkPinHash) {
        s.delete(key);
        hit = true;
      }
    };
    tx.oncomplete = () => resolve(hit);
    tx.onerror = () => reject(tx.error ?? req.error ?? new Error('indexedDBFailed'));
    tx.onabort = () => reject(tx.error ?? new Error('indexedDBAborted'));
  });
}

/** Marker `kit` per questo escrow, create-only: un secondo add dello stesso hash rifiuta (ConstraintError) e il valore non cambia mai. */
export const addKitMarker = (userId: string, marker: KitMarker) => add(PENDING, kitKey(userId, marker.escrowHash), marker).then(() => undefined);

export async function listKitMarkers(userId: string): Promise<KitMarker[]> {
  return (await run<KitMarker[]>(PENDING, 'readonly', (s) => s.getAll(kitRange(userId)))) ?? [];
}

/** Cancella solo il marker di quell'escrow; idempotente. */
export const deleteKitMarker = (userId: string, escrowHash: string) => del(PENDING, kitKey(userId, escrowHash)).then(() => undefined);

/** Slot `kit` di 1.14.0 (P2), mai piu' scritto: si legge e si cancella come prima. */
export async function getLegacyKitMarker(userId: string): Promise<KitMarker | null> {
  const m = await get<KitMarker>(PENDING, legacyKitKey(userId));
  return m?.kind === 'kit' ? m : null;
}

/** Compare-and-delete dello slot legacy: solo se ha ancora quell'escrowHash. */
export async function deleteLegacyKitMarkerIf(userId: string, escrowHash: string): Promise<boolean> {
  const db = await openDb();
  return new Promise<boolean>((resolve, reject) => {
    const tx = db.transaction(PENDING, 'readwrite');
    const s = tx.objectStore(PENDING);
    const key = legacyKitKey(userId);
    let hit = false;
    const req = s.get(key);
    req.onsuccess = () => {
      const cur = req.result as KitMarker | undefined;
      if (cur?.kind === 'kit' && cur.escrowHash === escrowHash) {
        s.delete(key);
        hit = true;
      }
    };
    tx.oncomplete = () => resolve(hit);
    tx.onerror = () => reject(tx.error ?? req.error ?? new Error('indexedDBFailed'));
    tx.onabort = () => reject(tx.error ?? new Error('indexedDBAborted'));
  });
}

// Recupero (D2: nessun upgrade dell'IDB, niente VersionError nelle schede col bundle vecchio). La chiave effimera sta in `deviceKeys`
// sotto un id che getDeviceKey(userId) non incontra mai. Scritture create-only (add) e compare-and-set in UNA transazione: schede e chiamate concorrenti non si sovrascrivono.
const recoveryKeyId = (userId: string) => `recovery:${userId}`;
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

export async function getRecoveryKey(userId: string): Promise<RecoveryKey | null> {
  return (await get<RecoveryKey>(KEYS, recoveryKeyId(userId))) ?? null;
}

/** Salva la coppia prima della POST (requestId null). ConstraintError se c'e' gia' una chiave di recupero. */
export const addRecoveryKey = (userId: string, key: { privateKey: CryptoKey; publicRaw: Uint8Array }, createdAt: number = Date.now()) =>
  add(KEYS, recoveryKeyId(userId), { requestId: null, privateKey: key.privateKey, publicRaw: key.publicRaw, createdAt } satisfies RecoveryKey).then(() => undefined);

/** Legge la chiave di recupero e, se `act` la accetta, la riscrive o cancella: tutto in una transazione readwrite. true = `act` ha agito. */
async function ifRecoveryKey(userId: string, act: (s: IDBObjectStore, key: string, cur: RecoveryKey) => boolean): Promise<boolean> {
  const db = await openDb();
  return new Promise<boolean>((resolve, reject) => {
    const tx = db.transaction(KEYS, 'readwrite');
    const s = tx.objectStore(KEYS);
    const key = recoveryKeyId(userId);
    let hit = false;
    const req = s.get(key);
    req.onsuccess = () => {
      const cur = req.result as RecoveryKey | undefined;
      if (cur) hit = act(s, key, cur);
    };
    tx.oncomplete = () => resolve(hit);
    tx.onerror = () => reject(tx.error ?? req.error ?? new Error('indexedDBFailed'));
    tx.onabort = () => reject(tx.error ?? new Error('indexedDBAborted'));
  });
}

/** Lega alla richiesta la chiave che ha questa `publicRaw` ed e' ancora non legata (o gia' legata allo stesso requestId). false = chiave assente o cambiata. */
export const bindRecoveryKeyIf = (userId: string, publicRaw: Uint8Array, requestId: string) =>
  ifRecoveryKey(userId, (s, key, cur) => {
    if (!sameBytes(cur.publicRaw, publicRaw) || (cur.requestId !== null && cur.requestId !== requestId)) return false;
    if (cur.requestId === null) s.put({ ...cur, requestId }, key);
    return true;
  });

/**
 * Cancella la chiave solo se: `{ requestId }` e' legata a quella richiesta; `{ publicRaw, olderThan? }` e' ancora non legata, ha quella pubblica
 * e (se `olderThan`, in ms) e' stata creata a quel momento o prima. false = nulla di cancellato.
 */
export const deleteRecoveryKeyIf = (userId: string, cond: { requestId: string } | { publicRaw: Uint8Array; olderThan?: number }) =>
  ifRecoveryKey(userId, (s, key, cur) => {
    const ok = 'requestId' in cond
      ? cur.requestId === cond.requestId
      : cur.requestId === null && sameBytes(cur.publicRaw, cond.publicRaw) && (cond.olderThan === undefined || (cur.createdAt ?? 0) <= cond.olderThan);
    if (ok) s.delete(key);
    return ok;
  });

/** "Rimuovi vault da questo dispositivo": chiave, share e marker dell'utente (range kit, slot legacy, pin). Il `del` di `:recovery` pulisce i marker del modello precedente. */
export async function removeDevice(userId: string): Promise<void> {
  await del(KEYS, userId);
  await del(KEYS, recoveryKeyId(userId));
  await del(SHARES, userId);
  await run(PENDING, 'readwrite', (s) => s.delete(kitRange(userId)));
  await del(PENDING, legacyKitKey(userId));
  await del(PENDING, pinKey(userId));
  await del(PENDING, `${userId}:recovery`);
}
