import { rawArgon2 } from './argon2Core';

// Nessun controllo qui: il controllo di kdfParams vive nel wrapper (argon2.ts).
self.onmessage = async (e: MessageEvent<{ id: number; pin: string; salt: Uint8Array | string; m: number; t: number; p: number }>) => {
  const { id, pin, salt, m, t, p } = e.data;
  try {
    const out = await rawArgon2(pin, salt, { m, t, p });
    (self as unknown as Worker).postMessage({ id, ok: true, out });
  } catch {
    (self as unknown as Worker).postMessage({ id, ok: false });
  }
};
