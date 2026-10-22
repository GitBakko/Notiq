// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// window finto (solo EventTarget) PRIMA degli import: vaultStore registra il listener "storage" e persist usa localStorage
vi.hoisted(() => {
  const mem = new Map<string, string>();
  (globalThis as unknown as { window: unknown }).window = Object.assign(new EventTarget(), {
    localStorage: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) },
  });
});

import { clearVaultCodecCache, decryptItem, encryptItem, MAX_PLAIN_BYTES, VaultLockedError } from '../vaultCodec';
import { useVaultStore, type VaultKeys } from '../../store/vaultStore';
import { generateSigKey, generateVkRaw, importVk } from '../../utils/vaultCrypto';

const U = 'u1';
const EPOCH = 1;
const doc = JSON.stringify({ type: 'doc', content: [] });
let keys: VaultKeys;
const unlockWith = (k: VaultKeys) => useVaultStore.setState({ keys: k, unlockedUserId: U, epoch: EPOCH, isUnlocked: true });

beforeEach(async () => {
  const vk = await importVk(generateVkRaw());
  keys = { vkHkdf: vk.hkdf, vkAes: vk.aes, sigKey: (await generateSigKey()).privateKey };
  unlockWith(keys);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await useVaultStore.getState().lockVault();
  clearVaultCodecCache();
});

describe('vaultCodec', () => {
  it('round-trip con le chiavi dello store; id o tipo sbagliati non decifrano', async () => {
    const e = await encryptItem('n1', 'NOTE', { t: 'Titolo', c: doc });
    expect(await decryptItem('n1', 'NOTE', e)).toEqual({ t: 'Titolo', c: doc });
    await expect(decryptItem('n2', 'NOTE', e)).rejects.toBeTruthy();
    await expect(decryptItem('n1', 'CREDENTIAL', e)).rejects.toBeTruthy();
  });

  it('cache: la seconda decifratura non rifa la crittografia; svuotata al lock', async () => {
    const e = await encryptItem('n1', 'NOTE', { t: 'T', c: doc });
    const spy = vi.spyOn(globalThis.crypto.subtle, 'decrypt');
    await decryptItem('n1', 'NOTE', e);
    await decryptItem('n1', 'NOTE', e);
    expect(spy).toHaveBeenCalledTimes(1);

    await useVaultStore.getState().lockVault();
    await expect(decryptItem('n1', 'NOTE', e)).rejects.toBeInstanceOf(VaultLockedError);

    unlockWith(keys); // stesse chiavi: la cache NON deve essere sopravvissuta al lock
    await decryptItem('n1', 'NOTE', e);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('la cache non e\' condivisa fra id: stesso envelope su un altro id fallisce anche dopo un hit', async () => {
    const e = await encryptItem('n1', 'NOTE', { t: 'T', c: doc });
    await decryptItem('n1', 'NOTE', e);
    await expect(decryptItem('n2', 'NOTE', e)).rejects.toBeTruthy();
  });

  it('FIFO a 500 voci', async () => {
    const envs: string[] = [];
    for (let i = 0; i < 501; i++) envs.push(await encryptItem(`n${i}`, 'NOTE', { t: 't', c: doc }));
    for (let i = 0; i < 501; i++) await decryptItem(`n${i}`, 'NOTE', envs[i]);
    const spy = vi.spyOn(globalThis.crypto.subtle, 'decrypt');
    await decryptItem('n500', 'NOTE', envs[500]);
    expect(spy).toHaveBeenCalledTimes(0); // l'ultima e' ancora in cache
    await decryptItem('n0', 'NOTE', envs[0]);
    expect(spy).toHaveBeenCalledTimes(1); // la prima e' stata espulsa
    // 501 cifrature e 501 decifrature WebCrypto vere (serve superare il tetto di 500 voci): ~0.2 s in locale, ma oltre i 5 s di default su CI o
    // macchine cariche. Il test resta significativo (nessun mock del tetto): si allarga solo il timeout.
  }, 30_000);

  it('flusher pre-lock: con il contesto catturato cifra anche a store gia\' azzerato, senza ripopolare la cache', async () => {
    let flushed = '';
    const unregister = useVaultStore.getState().registerPreLock(async (ctx) => {
      flushed = await encryptItem('n1', 'NOTE', { t: 'ultimo', c: doc }, ctx);
    });
    await useVaultStore.getState().lockVault();
    unregister();
    expect(flushed).toMatch(/^nv3\.1\./);

    unlockWith(keys);
    expect(await decryptItem('n1', 'NOTE', flushed)).toEqual({ t: 'ultimo', c: doc });
  });
});

describe('vaultCodec cache: chiave noteId|noteType con controllo dell envelope e tetto in byte', () => {
  it('stesso id, envelope diverso (nota ri-cifrata): non si serve il vecchio decifrato', async () => {
    const e1 = await encryptItem('n1', 'NOTE', { t: 'T', c: 'uno' });
    const e2 = await encryptItem('n1', 'NOTE', { t: 'T', c: 'due' });
    expect(await decryptItem('n1', 'NOTE', e1)).toEqual({ t: 'T', c: 'uno' });
    expect(await decryptItem('n1', 'NOTE', e2)).toEqual({ t: 'T', c: 'due' });
    expect(await decryptItem('n1', 'NOTE', e2)).toEqual({ t: 'T', c: 'due' });
  });

  it('tetto in byte: oltre MAX_PLAIN_BYTES la voce piu vecchia viene espulsa', async () => {
    const c = 'x'.repeat(1_000_000); // 2 MB di stringa JS per voce
    const n = Math.floor(MAX_PLAIN_BYTES / 2_000_000) + 1; // la n-esima manda il totale oltre il tetto
    const envs: string[] = [];
    for (let i = 0; i < n; i++) envs.push(await encryptItem('b' + i, 'NOTE', { t: '', c }));
    for (let i = 0; i < n; i++) await decryptItem('b' + i, 'NOTE', envs[i]);
    const spy = vi.spyOn(globalThis.crypto.subtle, 'decrypt');
    await decryptItem('b' + (n - 1), 'NOTE', envs[n - 1]);
    expect(spy).toHaveBeenCalledTimes(0); // l ultima e in cache
    await decryptItem('b0', 'NOTE', envs[0]);
    expect(spy).toHaveBeenCalledTimes(1); // la prima e stata espulsa dal tetto in byte
  });
});
