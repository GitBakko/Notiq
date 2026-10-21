// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { installFakeIndexedDb, reset, stores, fail } from './fakeIndexedDb';
import {
  getDeviceKey, getOrCreateDeviceKey, getShare, putShare, deleteShare, getPending, setPending, clearPending, removeDevice,
} from '../deviceKeyStore';
import { encryptShare, decryptShare } from '../../utils/vaultCrypto';

beforeAll(installFakeIndexedDb);
beforeEach(reset);

describe('deviceKeyStore', () => {
  it('crea una sola chiave AES-GCM non-extractable per utente, in un db separato da Dexie', async () => {
    expect(await getDeviceKey('u1')).toBeNull();
    const k = await getOrCreateDeviceKey('u1');
    expect(k.extractable).toBe(false);
    expect(k.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    // stessa chiave al secondo giro (comportamento, non identita': IndexedDB clona)
    const k2 = await getOrCreateDeviceKey('u1');
    const ct = await encryptShare(k, new Uint8Array(32).fill(7), 'u1', 0);
    expect(await decryptShare(k2, ct, 'u1', 0)).toEqual(new Uint8Array(32).fill(7));
    const other = await getOrCreateDeviceKey('u2');
    await expect(decryptShare(other, ct, 'u1', 0)).rejects.toThrow();
    expect([...stores.keys()].sort()).toEqual(['deviceKeys', 'pending', 'shares']);
  });

  it('share: round trip con AAD device|userId|epoch', async () => {
    const k = await getOrCreateDeviceKey('u1');
    const share = crypto.getRandomValues(new Uint8Array(32));
    const shareEnc = await encryptShare(k, share, 'u1', 4);
    await putShare('u1', { epoch: 4, shareEnc, wrappedVkSigKey: new Uint8Array([1, 2]) });
    const got = (await getShare('u1'))!;
    expect(got.epoch).toBe(4);
    expect(await decryptShare(k, got.shareEnc, 'u1', 4)).toEqual(share);
    await expect(decryptShare(k, got.shareEnc, 'u1', 5)).rejects.toThrow();
    await deleteShare('u1');
    expect(await getShare('u1')).toBeNull();
  });

  it('marker pending: salva, legge, cancella; removeDevice pulisce tutto', async () => {
    await getOrCreateDeviceKey('u1');
    await putShare('u1', { epoch: 0, shareEnc: new Uint8Array(1), wrappedVkSigKey: new Uint8Array(1) });
    await setPending('u1', { kind: 'kit', escrowHash: 'ab', confirmed: false });
    expect(await getPending('u1', 'kit')).toEqual({ kind: 'kit', escrowHash: 'ab', confirmed: false });
    await clearPending('u1', 'kit');
    expect(await getPending('u1', 'kit')).toBeNull();
    await setPending('u1', { kind: 'pin', rev: 3, wrappedVkPinHash: 'cd' });
    await setPending('u1', { kind: 'kit', escrowHash: 'ab', confirmed: false });
    await removeDevice('u1');
    expect(stores.get('deviceKeys')!.size + stores.get('shares')!.size + stores.get('pending')!.size).toBe(0);
  });

  it('marker kit e pin sono slot separati', async () => {
    await setPending('u1', { kind: 'kit', escrowHash: 'ab', confirmed: false });
    await setPending('u1', { kind: 'pin', rev: 1, wrappedVkPinHash: 'cd' });
    await clearPending('u1', 'pin');
    expect(await getPending('u1', 'pin')).toBeNull();
    expect(await getPending('u1', 'kit')).not.toBeNull();
  });

  it('due schede che creano la chiave insieme: add + rilettura, una sola chiave in uso', async () => {
    const [a, b] = await Promise.all([getOrCreateDeviceKey('u1'), getOrCreateDeviceKey('u1')]);
    expect(stores.get('deviceKeys')!.size).toBe(1);
    const ct = await encryptShare(a, new Uint8Array(32).fill(3), 'u1', 0);
    expect(await decryptShare(b, ct, 'u1', 0)).toEqual(new Uint8Array(32).fill(3));
  });

  it('chiave gia presente: non viene sovrascritta', async () => {
    const first = await getOrCreateDeviceKey('u1');
    const ct = await encryptShare(first, new Uint8Array(32).fill(5), 'u1', 0);
    await getOrCreateDeviceKey('u1');
    expect(await decryptShare((await getDeviceKey('u1'))!, ct, 'u1', 0)).toEqual(new Uint8Array(32).fill(5));
  });

  it('errore di scrittura: putShare rifiuta', async () => {
    fail.writes = 'shares';
    await expect(putShare('u1', { epoch: 0, shareEnc: new Uint8Array(1), wrappedVkSigKey: new Uint8Array(1) })).rejects.toThrow();
  });
});
