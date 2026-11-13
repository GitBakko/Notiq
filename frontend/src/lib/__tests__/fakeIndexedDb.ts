// IndexedDB finto, in memoria, quanto basta a deviceKeyStore (open, get/put/add/delete su object store, oncomplete).
// `stores` e' lo "store raw" su cui i test fanno gli assert. Un solo database condiviso: reset() svuota senza riaprire.
// put/add clonano il valore (structuredClone) come IndexedDB: nessun alias con l'oggetto del chiamante.
export const stores = new Map<string, Map<string, unknown>>();
/** Interruttore di errore: `writes` = nome dello store le cui scritture (put/add/delete) falliscono con un errore di transazione. */
export const fail: { writes: string | null } = { writes: null };

export function reset() {
  for (const m of stores.values()) m.clear();
  fail.writes = null;
}

type Handler = (() => void) | null;
interface Req<T> { result: T; error: Error | null; onsuccess: Handler; onerror: Handler }

interface Range { lower: string; upper: string }
const keysIn = (data: Map<string, unknown>, k: string | Range) =>
  typeof k === 'string' ? (data.has(k) ? [k] : []) : [...data.keys()].filter((key) => key >= k.lower && key <= k.upper);

function makeDb() {
  const db = {
    objectStoreNames: { contains: (n: string) => stores.has(n) },
    createObjectStore: (n: string) => { stores.set(n, new Map()); },
    close: () => {},
    onversionchange: null as Handler,
    transaction(name: string) {
      const data = stores.get(name)!;
      const tx = { oncomplete: null as Handler, onerror: null as Handler, onabort: null as Handler, error: null as Error | null };
      let pendingOps = 0;
      let aborted = false;
      const op = <T>(fn: () => T, write = false): Req<T> => {
        const req: Req<T> = { result: undefined as T, error: null, onsuccess: null, onerror: null };
        pendingOps++;
        queueMicrotask(() => {
          if (aborted) return;
          try {
            if (write && fail.writes === name) throw new Error('fakeIdbWriteFailed');
            req.result = fn();
          } catch (e) {
            aborted = true;
            req.error = tx.error = e as Error;
            req.onerror?.();
            tx.onerror?.();
            tx.onabort?.();
            return;
          }
          req.onsuccess?.();
          if (--pendingOps === 0) setTimeout(() => tx.oncomplete?.(), 0);
        });
        return req;
      };
      return {
        // le proprieta' on* vanno lette dall'oggetto restituito: si inoltra tramite getter/setter
        get oncomplete() { return tx.oncomplete; },
        set oncomplete(v: Handler) { tx.oncomplete = v; },
        get onerror() { return tx.onerror; },
        set onerror(v: Handler) { tx.onerror = v; },
        get onabort() { return tx.onabort; },
        set onabort(v: Handler) { tx.onabort = v; },
        get error() { return tx.error; },
        objectStore: () => ({
          get: (k: string) => op(() => data.get(k)),
          put: (v: unknown, k: string) => op(() => { data.set(k, structuredClone(v)); return k; }, true),
          add: (v: unknown, k: string) => op(() => {
            if (data.has(k)) throw Object.assign(new Error('ConstraintError'), { name: 'ConstraintError' });
            data.set(k, structuredClone(v));
            return k;
          }, true),
          // `k` puo' essere un range (come IDBKeyRange.bound): cancella tutte le chiavi comprese
          delete: (k: string | Range) => op(() => { for (const key of keysIn(data, k)) data.delete(key); return undefined; }, true),
          getAll: (range: Range) => op(() => keysIn(data, range).map((key) => structuredClone(data.get(key)))),
        }),
      };
    },
  };
  return db;
}

export function installFakeIndexedDb() {
  (globalThis as unknown as { IDBKeyRange: unknown }).IDBKeyRange = { bound: (lower: string, upper: string) => ({ lower, upper }) };
  (globalThis as unknown as { indexedDB: unknown }).indexedDB = {
    open() {
      const db = makeDb();
      const req = { result: db, error: null, onupgradeneeded: null as Handler, onsuccess: null as Handler, onerror: null as Handler, onblocked: null as Handler };
      setTimeout(() => {
        if (stores.size === 0) req.onupgradeneeded?.();
        req.onsuccess?.();
      }, 0);
      return req;
    },
  };
}
