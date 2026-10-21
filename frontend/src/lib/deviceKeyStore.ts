// Vault v3: chiave del dispositivo, share cifrato e marker pending. IndexedDB raw `notiq-vault-device`
// (NON Dexie, NON lib/db.ts): nessuna versione Dexie da toccare. Nessun segreto in chiaro: la chiave e'
// non-extractable, lo share e' cifrato con essa, i marker contengono solo hash e numeri (mai authKey, payload o PIN).
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

export type PendingMarker =
  | { kind: 'kit'; escrowHash: string; confirmed: false }
  | { kind: 'pin'; rev: number; wrappedVkPinHash: string };

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

// un marker per tipo: changePin non deve cancellare il promemoria del Kit non confermato
const pendingKey = (userId: string, kind: PendingMarker['kind']) => `${userId}:${kind}`;

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

export async function getPending(userId: string, kind: PendingMarker['kind']): Promise<PendingMarker | null> {
  return (await get<PendingMarker>(PENDING, pendingKey(userId, kind))) ?? null;
}

export const setPending = (userId: string, marker: PendingMarker) =>
  put(PENDING, pendingKey(userId, marker.kind), marker).then(() => undefined);

export const clearPending = (userId: string, kind: PendingMarker['kind']) =>
  del(PENDING, pendingKey(userId, kind)).then(() => undefined);

/** "Rimuovi vault da questo dispositivo": chiave, share e marker dell'utente. */
export async function removeDevice(userId: string): Promise<void> {
  await del(KEYS, userId);
  await del(SHARES, userId);
  await del(PENDING, pendingKey(userId, 'kit'));
  await del(PENDING, pendingKey(userId, 'pin'));
}
