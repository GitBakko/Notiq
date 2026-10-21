export interface KdfParams { m: number; t: number; p: number }

// Unica fonte per i keyring NUOVI (setup, cambio PIN). Lo sblocco usa i kdfParams del keyring.
export const DEFAULT_KDF: KdfParams = { m: 65536, t: 3, p: 1 };

const TIMEOUT_MS = 30_000;

type Salt = Uint8Array | string;
interface Pending {
  worker: Worker;
  resolve: (v: Uint8Array) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

let current: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

const kdfFailed = () => new Error('kdfFailed');

// Termina l'istanza e rifiuta subito le sue richieste pendenti.
function killWorker(w: Worker) {
  w.terminate();
  if (current === w) current = null;
  for (const [id, p] of pending) {
    if (p.worker !== w) continue;
    clearTimeout(p.timer);
    pending.delete(id);
    p.reject(kdfFailed());
  }
}

function getWorker(): Worker {
  if (current) return current;
  const w = new Worker(new URL('./argon2.worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (e: MessageEvent<{ id: number; ok: boolean; out?: Uint8Array }>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(e.data.id);
    if (e.data.ok && e.data.out) p.resolve(e.data.out);
    else { p.reject(kdfFailed()); killWorker(w); }
  };
  w.onerror = () => killWorker(w);
  current = w;
  return w;
}

/** Per i bench: termina il Worker corrente; il successivo si ricrea alla chiamata seguente. */
export function resetArgon2Worker() {
  if (current) killWorker(current);
}

/** Argon2id senza controlli sui parametri (usata dai KAT). Il PIN e' normalizzato NFC. */
export async function argon2Raw(pin: string, salt: Salt, params: KdfParams): Promise<Uint8Array> {
  const nfc = pin.normalize('NFC');
  if (typeof Worker === 'undefined') {
    try {
      const { rawArgon2 } = await import('./argon2Core');
      return await rawArgon2(nfc, salt, params);
    } catch {
      throw kdfFailed();
    }
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    let w: Worker;
    try { w = getWorker(); } catch { reject(kdfFailed()); return; }
    const id = nextId++;
    // Il timer termina solo la propria istanza.
    const timer = setTimeout(() => killWorker(w), TIMEOUT_MS);
    pending.set(id, { worker: w, resolve, reject, timer });
    try {
      w.postMessage({ id, pin: nfc, salt, m: params.m, t: params.t, p: params.p });
    } catch {
      killWorker(w);
    }
  });
}

/** S = Argon2id(NFC(PIN), pinSalt, kdfParams) dopo il controllo dei parametri del server. */
export async function deriveS(pin: string, salt: Uint8Array, params: KdfParams): Promise<Uint8Array> {
  if (!(salt instanceof Uint8Array) || salt.length !== 16) throw kdfFailed();
  const { m, t, p } = params;
  if (![m, t, p].every(Number.isInteger) || m < 65536 || m > 1048576 || t < 3 || t > 10 || p !== 1) {
    throw kdfFailed();
  }
  return argon2Raw(pin, salt, { m, t, p });
}
