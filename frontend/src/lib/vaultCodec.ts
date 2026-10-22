import { useVaultStore, type VaultKeys } from '../store/vaultStore';
import { decryptItem as decryptEnvelope, deriveNoteKey, encryptItem as encryptEnvelope, sha256hex } from '../utils/vaultCrypto';

// Cifra/decifra gli item vault (plan 5.6) con le chiavi dello store. Condiviso fra features (lib/): niente import da features/.
// Il plaintext vive solo nella cache in memoria qui sotto, che si svuota a ogni cambio di chiavi (lock, logout, cambio utente).

export type VaultNoteType = 'NOTE' | 'CREDENTIAL';

/** Contesto di cifratura esplicito: serve ai flusher pre-lock e al reconcile, che lavorano con le chiavi catturate. */
export interface VaultCodecCtx { keys: VaultKeys; userId: string; epoch: number }

export class VaultLockedError extends Error {
  constructor() {
    super('vault.locked');
    this.name = 'VaultLockedError';
  }
}

const MAX_CACHE = 500;
/** Tetto di memoria dei decifrati (stringhe JS: 2 byte per carattere). */
export const MAX_PLAIN_BYTES = 32 * 1024 * 1024;
const kNotes = new Map<string, CryptoKey>();
// Chiave noteId|noteType; l'envelope e' verificato con lunghezza + hash (non lo si tiene in memoria).
interface PlainEntry { len: number; hash: string; out: { t: string; c: string }; bytes: number }
const plain = new Map<string, PlainEntry>();
let plainBytes = 0;
let cacheKeys: VaultKeys | null = null;

export function clearVaultCodecCache() {
  kNotes.clear();
  plain.clear();
  plainBytes = 0;
  cacheKeys = null;
}

function plainSet(k: string, e: PlainEntry) {
  const old = plain.get(k);
  if (old) {
    plain.delete(k);
    plainBytes -= old.bytes;
  }
  if (e.bytes > MAX_PLAIN_BYTES) return; // da solo non ci sta: non si memorizza
  while (plain.size > 0 && (plain.size >= MAX_CACHE || plainBytes + e.bytes > MAX_PLAIN_BYTES)) {
    const first = plain.keys().next().value as string;
    plainBytes -= plain.get(first)!.bytes;
    plain.delete(first);
  }
  plain.set(k, e);
  plainBytes += e.bytes;
}

// Il lock azzera `keys` nello store: la cache di K_note e del plaintext muore con lui.
useVaultStore.subscribe((s, prev) => {
  if (s.keys !== prev.keys) clearVaultCodecCache();
});

function fifoSet<V>(m: Map<string, V>, k: string, v: V) {
  if (m.size >= MAX_CACHE) m.delete(m.keys().next().value as string);
  m.set(k, v);
}

const isLive = (keys: VaultKeys) => useVaultStore.getState().keys === keys;

function ctxOf(ctx?: VaultCodecCtx): VaultCodecCtx {
  if (ctx) return ctx;
  const { keys, unlockedUserId, epoch } = useVaultStore.getState();
  if (!keys || !unlockedUserId || epoch == null) throw new VaultLockedError();
  return { keys, userId: unlockedUserId, epoch };
}

async function noteKey(keys: VaultKeys, noteId: string): Promise<CryptoKey> {
  const vk = { hkdf: keys.vkHkdf, aes: keys.vkAes };
  // Chiavi gia' azzerate (flusher pre-lock): si deriva senza memorizzare nulla.
  if (!isLive(keys)) return deriveNoteKey(vk, noteId);
  if (cacheKeys !== keys) {
    clearVaultCodecCache();
    cacheKeys = keys;
  }
  let k = kNotes.get(noteId);
  if (!k) {
    k = await deriveNoteKey(vk, noteId);
    // Un lock durante la derivazione ha gia' svuotato la cache: non la si ripopola.
    if (isLive(keys)) fifoSet(kNotes, noteId, k);
  }
  return k;
}

export async function encryptItem(noteId: string, noteType: VaultNoteType, item: { t: string; c: string }, ctx?: VaultCodecCtx): Promise<string> {
  const { keys, userId, epoch } = ctxOf(ctx);
  return encryptEnvelope(await noteKey(keys, noteId), { userId, noteId, noteType, epoch }, item);
}

export async function decryptItem(noteId: string, noteType: VaultNoteType, envelope: string, ctx?: VaultCodecCtx): Promise<{ t: string; c: string }> {
  const { keys, userId, epoch } = ctxOf(ctx);
  const ck = `${noteId}|${noteType}`;
  const hash = await sha256hex(envelope);
  const hit = isLive(keys) ? plain.get(ck) : undefined;
  if (hit && hit.len === envelope.length && hit.hash === hash) return { ...hit.out };
  const out = await decryptEnvelope(await noteKey(keys, noteId), { userId, noteId, noteType, epoch }, envelope);
  if (isLive(keys)) plainSet(ck, { len: envelope.length, hash, out, bytes: (out.t.length + out.c.length) * 2 });
  return { ...out };
}
