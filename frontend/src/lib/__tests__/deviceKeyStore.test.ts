// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { installFakeIndexedDb, reset, stores, fail } from './fakeIndexedDb';
import {
  getDeviceKey, getOrCreateDeviceKey, getShare, putShare, deleteShare, getPending, setPending, clearPending, removeDevice,
  getRecoveryKey, addRecoveryKey, bindRecoveryKeyIf, deleteRecoveryKeyIf,
  addKitMarker, listKitMarkers, deleteKitMarker, getLegacyKitMarker, deleteLegacyKitMarkerIf, clearPinMarkerIf, type KitMarker,
} from '../deviceKeyStore';
import { encryptShare, decryptShare } from '../../utils/vaultCrypto';
import { generateRecoveryKeyPair } from '../../utils/vaultRecoveryCrypto';

const kit = (escrowHash: string, o: Partial<KitMarker> = {}): KitMarker => ({ kind: 'kit', escrowHash, epoch: 1, rev: 4, origin: 'regenerate', ...o });

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

  it('marker pin: salva, legge, cancella; removeDevice pulisce tutto', async () => {
    await getOrCreateDeviceKey('u1');
    await putShare('u1', { epoch: 0, shareEnc: new Uint8Array(1), wrappedVkSigKey: new Uint8Array(1) });
    await setPending('u1', { kind: 'pin', rev: 3, wrappedVkPinHash: 'cd' });
    expect(await getPending('u1', 'pin')).toEqual({ kind: 'pin', rev: 3, wrappedVkPinHash: 'cd' });
    await clearPending('u1', 'pin');
    expect(await getPending('u1', 'pin')).toBeNull();
    await setPending('u1', { kind: 'pin', rev: 3, wrappedVkPinHash: 'cd' });
    await addKitMarker('u1', kit('ab'));
    stores.get('pending')!.set('u1:kit', { kind: 'kit', escrowHash: 'old', confirmed: false }); // slot legacy P2
    await removeDevice('u1');
    expect(stores.get('deviceKeys')!.size + stores.get('shares')!.size + stores.get('pending')!.size).toBe(0);
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

describe('deviceKeyStore: recupero (D2, nessun cambio di versione)', () => {
  it('store invariati: solo deviceKeys, shares, pending; DB_VERSION 1 (indexedDB.open(name, 1))', async () => {
    const idb = (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB;
    const open = vi.spyOn(idb, 'open');
    stores.clear();
    vi.resetModules();
    const fresh = await import('../deviceKeyStore');
    await fresh.getRecoveryKey('u1');
    expect(open).toHaveBeenCalledWith('notiq-vault-device', 1);
    expect([...stores.keys()].sort()).toEqual(['deviceKeys', 'pending', 'shares']);
    open.mockRestore();
  });

  it('chiave effimera: riletta non-extractable e usabile per deriveBits, requestId null', async () => {
    const kp = await generateRecoveryKeyPair();
    await addRecoveryKey('u1', kp);
    const got = (await getRecoveryKey('u1'))!;
    expect(got.requestId).toBeNull();
    expect(got.privateKey.extractable).toBe(false);
    expect(got.privateKey.usages).toEqual(['deriveBits']);
    expect(got.publicRaw).toEqual(kp.publicRaw);
    const other = await generateRecoveryKeyPair();
    const pub = await crypto.subtle.importKey('raw', other.publicRaw, { name: 'ECDH', namedCurve: 'P-384' }, false, []);
    const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, got.privateKey, 384);
    expect(bits.byteLength).toBe(48);
    expect(stores.get('deviceKeys')!.has('recovery:u1')).toBe(true);
  });

  it('secondo add -> ConstraintError e la prima chiave resta', async () => {
    const a = await generateRecoveryKeyPair();
    const b = await generateRecoveryKeyPair();
    await addRecoveryKey('u1', a);
    await expect(addRecoveryKey('u1', b)).rejects.toMatchObject({ name: 'ConstraintError' });
    expect((await getRecoveryKey('u1'))!.publicRaw).toEqual(a.publicRaw);
  });

  it('addRecoveryKey registra createdAt (default: adesso, oppure quello passato)', async () => {
    const before = Date.now();
    await addRecoveryKey('u1', await generateRecoveryKeyPair());
    const t = (await getRecoveryKey('u1'))!.createdAt;
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(Date.now());
    await addRecoveryKey('u2', await generateRecoveryKeyPair(), 1234);
    expect((await getRecoveryKey('u2'))!.createdAt).toBe(1234);
  });

  describe('bindRecoveryKeyIf (compare-and-set in una transazione)', () => {
    it('lega solo la chiave con la stessa publicRaw e requestId null; idempotente per lo stesso requestId', async () => {
      const kp = await generateRecoveryKeyPair();
      expect(await bindRecoveryKeyIf('u1', kp.publicRaw, 'r1')).toBe(false); // nessuna chiave
      await addRecoveryKey('u1', kp);
      expect(await bindRecoveryKeyIf('u1', (await generateRecoveryKeyPair()).publicRaw, 'r1')).toBe(false); // altra chiave
      expect((await getRecoveryKey('u1'))!.requestId).toBeNull();
      expect(await bindRecoveryKeyIf('u1', kp.publicRaw, 'r1')).toBe(true);
      expect((await getRecoveryKey('u1'))!.requestId).toBe('r1');
      expect(await bindRecoveryKeyIf('u1', kp.publicRaw, 'r1')).toBe(true);
      expect(await bindRecoveryKeyIf('u1', kp.publicRaw, 'r2')).toBe(false);
      expect((await getRecoveryKey('u1'))!.requestId).toBe('r1');
    });
  });

  describe('deleteRecoveryKeyIf (compare-and-delete in una transazione)', () => {
    it('{requestId}: cancella solo la chiave legata a quella richiesta', async () => {
      const kp = await generateRecoveryKeyPair();
      expect(await deleteRecoveryKeyIf('u1', { requestId: 'r1' })).toBe(false);
      await addRecoveryKey('u1', kp);
      expect(await deleteRecoveryKeyIf('u1', { requestId: 'r1' })).toBe(false); // non legata
      await bindRecoveryKeyIf('u1', kp.publicRaw, 'r1');
      expect(await deleteRecoveryKeyIf('u1', { requestId: 'r2' })).toBe(false);
      expect(await getRecoveryKey('u1')).not.toBeNull();
      expect(await deleteRecoveryKeyIf('u1', { requestId: 'r1' })).toBe(true);
      expect(await getRecoveryKey('u1')).toBeNull();
    });

    it('{publicRaw}: solo non legata, stessa pubblica; con olderThan solo se creata a quel momento o prima', async () => {
      const kp = await generateRecoveryKeyPair();
      await addRecoveryKey('u1', kp, 1000);
      expect(await deleteRecoveryKeyIf('u1', { publicRaw: (await generateRecoveryKeyPair()).publicRaw })).toBe(false);
      expect(await deleteRecoveryKeyIf('u1', { publicRaw: kp.publicRaw, olderThan: 999 })).toBe(false);
      expect(await getRecoveryKey('u1')).not.toBeNull();
      expect(await deleteRecoveryKeyIf('u1', { publicRaw: kp.publicRaw, olderThan: 1000 })).toBe(true);
      await addRecoveryKey('u1', kp, 1000);
      await bindRecoveryKeyIf('u1', kp.publicRaw, 'r1');
      expect(await deleteRecoveryKeyIf('u1', { publicRaw: kp.publicRaw })).toBe(false); // legata
      expect(await getRecoveryKey('u1')).not.toBeNull();
    });

    it('una chiave nuova con altra pubblica non si cancella con la condizione della vecchia', async () => {
      const k1 = await generateRecoveryKeyPair();
      const k2 = await generateRecoveryKeyPair();
      await addRecoveryKey('u1', k1, 1);
      await deleteRecoveryKeyIf('u1', { publicRaw: k1.publicRaw });
      await addRecoveryKey('u1', k2);
      expect(await deleteRecoveryKeyIf('u1', { publicRaw: k1.publicRaw })).toBe(false);
      expect((await getRecoveryKey('u1'))!.publicRaw).toEqual(k2.publicRaw);
    });
  });

  it('getDeviceKey non restituisce mai la chiave di recupero; isolamento tra utenti', async () => {
    await addRecoveryKey('u1', await generateRecoveryKeyPair());
    expect(await getDeviceKey('u1')).toBeNull();
    const dev = await getOrCreateDeviceKey('u1');
    expect(dev.algorithm).toMatchObject({ name: 'AES-GCM' });
    expect(await getRecoveryKey('u2')).toBeNull();
  });

  it('removeDevice pulisce chiave di recupero e residui del vecchio marker `:recovery`, non gli altri utenti', async () => {
    await getOrCreateDeviceKey('u1');
    await addRecoveryKey('u1', await generateRecoveryKeyPair());
    stores.get('pending')!.set('u1:recovery', { kind: 'recovery' }); // residuo del modello precedente
    await addKitMarker('u1', kit('ab'));
    await getOrCreateDeviceKey('u2');
    await removeDevice('u1');
    expect(stores.get('deviceKeys')!.has('recovery:u1')).toBe(false);
    expect(stores.get('pending')!.size).toBe(0);
    expect(stores.get('deviceKeys')!.has('u2')).toBe(true);
  });

  it('errore di scrittura: addRecoveryKey, bindRecoveryKeyIf e deleteRecoveryKeyIf rifiutano', async () => {
    const kp = await generateRecoveryKeyPair();
    await addRecoveryKey('u1', kp);
    fail.writes = 'deviceKeys';
    await expect(addRecoveryKey('u2', await generateRecoveryKeyPair())).rejects.toThrow();
    await expect(bindRecoveryKeyIf('u1', kp.publicRaw, 'r1')).rejects.toThrow();
    await expect(deleteRecoveryKeyIf('u1', { publicRaw: kp.publicRaw })).rejects.toThrow();
  });
});

describe('marker kit (uno per escrow, chiave <userId>:kit:<hash>)', () => {
  it('due hash convivono; il valore e immutabile (add): un secondo add dello stesso hash rifiuta', async () => {
    await addKitMarker('u1', kit('h1'));
    await addKitMarker('u1', kit('h2', { origin: 'recovery', requestId: 'r1' }));
    const l = await listKitMarkers('u1');
    expect(l.map((m) => m.escrowHash).sort()).toEqual(['h1', 'h2']);
    expect(l.find((m) => m.escrowHash === 'h2')).toMatchObject({ origin: 'recovery', requestId: 'r1' });
    await expect(addKitMarker('u1', kit('h1', { rev: 9 }))).rejects.toThrow();
    expect((await listKitMarkers('u1')).find((m) => m.escrowHash === 'h1')!.rev).toBe(4);
  });

  it('deleteKitMarker tocca solo il suo hash ed e idempotente', async () => {
    await addKitMarker('u1', kit('h1'));
    await addKitMarker('u1', kit('h2'));
    await deleteKitMarker('u1', 'h1');
    await deleteKitMarker('u1', 'h1');
    expect((await listKitMarkers('u1')).map((m) => m.escrowHash)).toEqual(['h2']);
  });

  it('listKitMarkers: nessuna collisione tra u1 e u10, ne con lo slot pin o legacy', async () => {
    await addKitMarker('u1', kit('h1'));
    await addKitMarker('u10', kit('h10'));
    await addKitMarker('u1x', kit('hx'));
    await setPending('u1', { kind: 'pin', rev: 1, wrappedVkPinHash: 'cd' });
    stores.get('pending')!.set('u1:kit', { kind: 'kit', escrowHash: 'old', confirmed: false });
    expect((await listKitMarkers('u1')).map((m) => m.escrowHash)).toEqual(['h1']);
    expect((await listKitMarkers('u10')).map((m) => m.escrowHash)).toEqual(['h10']);
    expect(await listKitMarkers('u2')).toEqual([]);
  });

  it('slot legacy: lettura e cancellazione solo se l hash coincide', async () => {
    expect(await getLegacyKitMarker('u1')).toBeNull();
    stores.get('pending')!.set('u1:kit', { kind: 'kit', escrowHash: 'old', confirmed: false });
    expect(await getLegacyKitMarker('u1')).toMatchObject({ escrowHash: 'old' });
    await deleteLegacyKitMarkerIf('u1', 'other');
    expect(await getLegacyKitMarker('u1')).not.toBeNull();
    await deleteLegacyKitMarkerIf('u1', 'old');
    expect(await getLegacyKitMarker('u1')).toBeNull();
  });

  it('removeDevice pulisce range, slot legacy e marker pin, ma non quelli di u10', async () => {
    await addKitMarker('u1', kit('h1'));
    await addKitMarker('u1', kit('h2'));
    await addKitMarker('u10', kit('h10'));
    await setPending('u1', { kind: 'pin', rev: 1, wrappedVkPinHash: 'cd' });
    stores.get('pending')!.set('u1:kit', { kind: 'kit', escrowHash: 'old' });
    await removeDevice('u1');
    expect([...stores.get('pending')!.keys()]).toEqual(['u10:kit:h10']);
  });

  it('IDB: solo hash, numeri, origin e requestId (mai segreti)', async () => {
    await addKitMarker('u1', kit('h1', { origin: 'recovery', requestId: 'r1' }));
    expect(Object.keys(stores.get('pending')!.get('u1:kit:h1') as object).sort()).toEqual(['epoch', 'escrowHash', 'kind', 'origin', 'requestId', 'rev']);
  });
});

describe('clearPinMarkerIf (compare-and-delete del marker pin)', () => {
  it('cancella solo se l hash del wrap coincide; true/false', async () => {
    expect(await clearPinMarkerIf('u1', 'cd')).toBe(false); // assente
    await setPending('u1', { kind: 'pin', rev: 1, wrappedVkPinHash: 'cd' });
    expect(await clearPinMarkerIf('u1', 'zz')).toBe(false);
    expect(await getPending('u1', 'pin')).not.toBeNull();
    expect(await clearPinMarkerIf('u1', 'cd')).toBe(true);
    expect(await getPending('u1', 'pin')).toBeNull();
    expect(await clearPinMarkerIf('u1', 'cd')).toBe(false); // gia cancellato da un'altra chiamata
  });

  it('non tocca i marker kit ne quelli di altri utenti', async () => {
    await addKitMarker('u1', kit('h1'));
    await setPending('u2', { kind: 'pin', rev: 1, wrappedVkPinHash: 'cd' });
    expect(await clearPinMarkerIf('u1', 'cd')).toBe(false);
    expect(await listKitMarkers('u1')).toHaveLength(1);
    expect(await getPending('u2', 'pin')).not.toBeNull();
  });
});
