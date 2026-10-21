import { argon2id } from 'hash-wasm';

// Unica chiamata hash-wasm: la usano sia il Worker sia il fallback senza Worker, cosi il KAT copre entrambi.
// Il PIN e' normalizzato NFC; nessun controllo sui parametri (vive in deriveS).
export function rawArgon2(
  pin: string,
  salt: Uint8Array | string,
  params: { m: number; t: number; p: number },
): Promise<Uint8Array> {
  return argon2id({
    password: pin.normalize('NFC'),
    salt,
    parallelism: params.p,
    iterations: params.t,
    memorySize: params.m,
    hashLength: 32,
    outputType: 'binary',
  });
}
