import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';

vi.mock('../services/audit.service', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/vaultRootKey.service', () => ({ releaseRootShare: vi.fn() }));

import prisma from '../plugins/prisma';
import { releaseRootShare } from '../services/vaultRootKey.service';
import { pepperStatus, verifierKey } from '../services/vault.service';
import { approveRecovery, cancelRecovery, completeRecovery, confirmRecovery, createRecoveryRequest, expireRecoveryRequests, releaseRecovery } from '../services/vaultRecovery.service';

const mp = prisma as any;
const U = 'user-1';
const ADMIN = 'admin-1';
const RID = 'recovery-1';
const ORIGINAL_PEPPER = process.env.VAULT_PEPPER_KEY;

beforeAll(() => { process.env.VAULT_PEPPER_KEY = crypto.randomBytes(32).toString('base64url'); });
afterAll(() => {
  if (ORIGINAL_PEPPER === undefined) delete process.env.VAULT_PEPPER_KEY;
  else process.env.VAULT_PEPPER_KEY = ORIGINAL_PEPPER;
});

function pub(): Buffer {
  const ecdh = crypto.createECDH('secp384r1');
  ecdh.generateKeys();
  return ecdh.getPublicKey();
}

function hash(part: 'A' | 'B', code: string): string {
  return crypto.createHmac('sha256', verifierKey()).update(`recovery|${RID}|${part}|${code}`).digest('hex');
}

beforeEach(() => {
  vi.clearAllMocks();
  mp.auditLog = { count: vi.fn(), create: vi.fn() };
  mp.$transaction = vi.fn();
  mp.vaultRequest.findFirst.mockResolvedValue(null);
  mp.vaultKeyring.updateMany.mockResolvedValue({ count: 1 });
  mp.vaultRequest.count.mockResolvedValue(0);
  mp.vaultRequest.create.mockImplementation(async ({ data }: any) => ({ id: RID, ...data }));
  mp.vaultRequest.updateMany.mockResolvedValue({ count: 1 });
  mp.vaultRequest.update.mockResolvedValue({});
  mp.auditLog.count.mockResolvedValue(0);
  mp.auditLog.create.mockResolvedValue({});
  mp.$transaction.mockImplementation(async (fn: any) => fn(mp));
});

describe('richiesta e approvazione', () => {
  it('crea PENDING_APPROVAL con fingerprint e metadati limitati', async () => {
    const result = await createRecoveryRequest(U, pub(), 'forgot', '192.0.2.1', 'agent');
    expect(result.id).toBe(RID);
    expect(result.fingerprint).toHaveLength(8);
    const data = mp.vaultRequest.create.mock.calls[0][0].data;
    expect(data.status).toBe('PENDING_APPROVAL');
    expect(data.clientEphPub).toHaveLength(97);
    expect(data.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
  });

  it('non crea una seconda richiesta aperta', async () => {
    mp.vaultRequest.findFirst.mockResolvedValue({ id: RID });
    await expect(createRecoveryRequest(U, pub(), undefined, 'ip', 'ua')).rejects.toMatchObject({ statusCode: 409 });
    expect(mp.vaultRequest.create).not.toHaveBeenCalled();
  });

  it('approvazione: due metà da 8 caratteri e solo HMAC nel DB', async () => {
    const result = await approveRecovery(ADMIN, RID);
    expect(result.codeA).toHaveLength(8);
    expect(result.codeB).toHaveLength(8);
    const data = mp.vaultRequest.update.mock.calls[0][0].data;
    expect(data.codeAHash).toBe(hash('A', result.codeA));
    expect(data.codeBHash).toBe(hash('B', result.codeB));
    expect(JSON.stringify(data)).not.toContain(result.codeA);
    expect(JSON.stringify(data)).not.toContain(result.codeB);
  });
});

describe('conferma e annullamento', () => {
  it('codice corretto -> WAITING dopo 72 ore e hash rimossi', async () => {
    mp.vaultRequest.findUnique.mockResolvedValue({ attempts: 1, codeAHash: hash('A', 'AAAAAAAA'), codeBHash: hash('B', 'BBBBBBBB') });
    const result = await confirmRecovery(U, RID, 'AAAAAAAA', 'BBBBBBBB');
    expect(result.status).toBe('WAITING');
    expect(result.notBefore.getTime()).toBeGreaterThan(Date.now() + 71 * 60 * 60 * 1000);
    const data = mp.vaultRequest.updateMany.mock.calls[1][0].data;
    expect(data.codeAHash).toBeNull();
    expect(data.codeBHash).toBeNull();
  });

  it('quinto errore -> EXPIRED', async () => {
    mp.vaultRequest.findUnique.mockResolvedValue({ attempts: 5, codeAHash: hash('A', 'AAAAAAAA'), codeBHash: hash('B', 'BBBBBBBB') });
    await expect(confirmRecovery(U, RID, 'CCCCCCCC', 'BBBBBBBB')).rejects.toMatchObject({ statusCode: 403 });
    expect(mp.vaultRequest.update).toHaveBeenCalledWith({ where: { id: RID }, data: { status: 'EXPIRED' } });
  });

  it('annullamento di una richiesta aperta', async () => {
    const result = await cancelRecovery(U, RID);
    expect(result.status).toBe('CANCELLED');
    const data = mp.vaultRequest.updateMany.mock.calls[0][0].data;
    expect(data.rootShareForClient).toBeNull();
    expect(data.rootSignature).toBeNull();
  });
});

describe('rilascio', () => {
  function waitingRow() {
    return {
      userId: U,
      clientEphPub: pub(),
      fingerprint: 'FP',
      notBefore: new Date(Date.now() - 1000),
      user: { vaultKeyring: { epoch: 2, rootKeyId: 'rk_test', sealedRootShare: Buffer.alloc(157, 1) } },
    };
  }

  it('sigilla e salva solo dopo una transizione WAITING -> RELEASED riuscita', async () => {
    mp.vaultRequest.findFirst.mockResolvedValue(waitingRow());
    (releaseRootShare as any).mockResolvedValue({ rootShareForClient: Buffer.alloc(157, 2), rootSignature: Buffer.alloc(64, 3) });
    const result = await releaseRecovery(ADMIN, RID, 'passphrase');
    expect(result.status).toBe('RELEASED');
    const data = mp.vaultRequest.updateMany.mock.calls[0][0].data;
    expect(data.rootShareForClient).toHaveLength(157);
    expect(data.rootSignature).toHaveLength(64);
  });

  it('se WAITING non esiste più, nessuna scrittura del seal', async () => {
    mp.vaultRequest.findFirst.mockResolvedValue(waitingRow());
    mp.vaultRequest.updateMany.mockResolvedValue({ count: 0 });
    const released = { rootShareForClient: Buffer.alloc(157, 2), rootSignature: Buffer.alloc(64, 3) };
    (releaseRootShare as any).mockResolvedValue(released);
    await expect(releaseRecovery(ADMIN, RID, 'passphrase')).rejects.toMatchObject({ statusCode: 409 });
    expect(released.rootShareForClient.equals(Buffer.alloc(157, 0))).toBe(true);
    expect(released.rootSignature.equals(Buffer.alloc(64, 0))).toBe(true);
  });
});

describe('completamento', () => {
  it('complete valido aggiorna keyring e richiesta nella stessa transazione; replay idempotente', async () => {
    const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const payload = JSON.stringify({
      rev: 3,
      wrap: { kdf: 'argon2id', kdfParams: { m: 65536, t: 10, p: 1 }, pinSalt: Buffer.alloc(16).toString('base64url'), wrappedVkPin: Buffer.alloc(60).toString('base64url'), authKey: Buffer.alloc(32).toString('base64url') },
      escrow: { escrowBlob: Buffer.alloc(60).toString('base64url'), sealedRootShare: Buffer.alloc(157).toString('base64url'), rootKeyId: 'rk_68a265761e7e37c7', userShareUnderVk: Buffer.alloc(48).toString('base64url') },
    });
    const keyring = { userId: U, status: 'READY', epoch: 2, pepperKeyId: pepperStatus().keyId, vkSigPub: pair.publicKey.export({ type: 'spki', format: 'der' }) };
    const msg = `notiq/vault/v3/proof|POST /api/vault/recovery/${RID}/complete|${U}|2|3|${crypto.createHash('sha256').update(payload).digest('hex')}`;
    const proof = crypto.sign('sha256', Buffer.from(msg), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' });
    const existing = { status: 'RELEASED', releaseExpiresAt: new Date(Date.now() + 10000), user: { vaultKeyring: keyring } };
    mp.vaultRequest.findFirst.mockResolvedValue(existing);
    const first = await completeRecovery(U, RID, payload, proof);
    expect(first).toEqual({ status: 'COMPLETED', idempotent: false });
    expect(mp.$transaction).toHaveBeenCalledTimes(1);
    expect(mp.vaultKeyring.updateMany).toHaveBeenCalledTimes(1);

    mp.vaultRequest.findFirst.mockResolvedValue({ status: 'COMPLETED', completedPayloadHash: crypto.createHash('sha256').update(payload).digest('hex') });
    const replay = await completeRecovery(U, RID, payload, proof);
    expect(replay).toEqual({ status: 'COMPLETED', idempotent: true });
  });
});

describe('scadenze', () => {
  it('pulisce i seal dei rilasci scaduti', async () => {
    mp.vaultRequest.updateMany.mockResolvedValue({ count: 1 });
    expect(await expireRecoveryRequests(new Date('2030-01-01T00:00:00Z'))).toBe(3);
    const releaseData = mp.vaultRequest.updateMany.mock.calls[2][0].data;
    expect(releaseData.rootShareForClient).toBeNull();
    expect(releaseData.rootSignature).toBeNull();
  });
});
