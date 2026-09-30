import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../plugins/prisma';
import { restoreNoteVersion } from '../services/noteVersion.service';
import { updateSharedNoteContent } from '../services/sharing.service';

vi.mock('../services/audit.service', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/email.service', () => ({ sendNotificationEmail: vi.fn().mockResolvedValue(undefined) }));

const mp = prisma as any;
const U = 'user-1';
const EPOCH = 2;
const env = (epoch = EPOCH) => `nv3.${epoch}.${'A'.repeat(16)}.${'B'.repeat(30)}`;
const LONG = 'x'.repeat(200);

async function fail(p: Promise<unknown>) {
  try {
    await p;
  } catch (e: any) {
    return e;
  }
  throw new Error('expected rejection');
}

function setVersion(content: string) {
  mp.noteVersion.findUnique.mockResolvedValue({ id: 'v1', noteId: 'n1', content, title: 'Old title' });
}

beforeEach(() => {
  vi.resetAllMocks();
  mp.note.update.mockResolvedValue({});
  mp.noteVersion.findFirst.mockResolvedValue(null);
  mp.noteVersion.findMany.mockResolvedValue([]);
  mp.noteVersion.deleteMany.mockResolvedValue({ count: 0 });
});

describe('restoreNoteVersion su nota vault con keyring', () => {
  beforeEach(() => {
    mp.note.findFirst.mockResolvedValue({ id: 'n1', content: LONG, title: 'T', isEncrypted: false, isVault: true });
  });

  it('versione non-envelope con READY: 422 plaintextRejected, niente snapshot ne update', async () => {
    mp.vaultKeyring.findUnique.mockResolvedValue({ status: 'READY', epoch: EPOCH });
    setVersion('{"type":"doc"}');
    const e = await fail(restoreNoteVersion(U, 'n1', 'v1'));
    expect(e.statusCode).toBe(422);
    expect(e.message).toBe('errors.vault.plaintextRejected');
    expect(mp.noteVersion.create).not.toHaveBeenCalled();
    expect(mp.note.update).not.toHaveBeenCalled();
  });

  it('envelope dell epoch corrente con READY: update con title vuoto e content envelope', async () => {
    mp.vaultKeyring.findUnique.mockResolvedValue({ status: 'READY', epoch: EPOCH });
    setVersion(env());
    await restoreNoteVersion(U, 'n1', 'v1');
    expect(mp.note.update).toHaveBeenCalledTimes(1);
    const data = mp.note.update.mock.calls[0][0].data;
    expect(data.title).toBe('');
    expect(data.content).toBe(env());
    expect(data.searchText).toBeNull();
    expect(data.ydocState).toBeNull();
  });

  it('envelope di epoch vecchia con READY: 422 stale', async () => {
    mp.vaultKeyring.findUnique.mockResolvedValue({ status: 'READY', epoch: EPOCH });
    setVersion(env(1));
    const e = await fail(restoreNoteVersion(U, 'n1', 'v1'));
    expect(e.statusCode).toBe(422);
    expect(e.message).toBe('errors.vault.stale');
    expect(mp.noteVersion.create).not.toHaveBeenCalled();
    expect(mp.note.update).not.toHaveBeenCalled();
  });

  it('RESET_PENDING: 422 notReady', async () => {
    mp.vaultKeyring.findUnique.mockResolvedValue({ status: 'RESET_PENDING', epoch: EPOCH });
    setVersion(env());
    const e = await fail(restoreNoteVersion(U, 'n1', 'v1'));
    expect(e.statusCode).toBe(422);
    expect(e.message).toBe('errors.vault.notReady');
    expect(mp.noteVersion.create).not.toHaveBeenCalled();
    expect(mp.note.update).not.toHaveBeenCalled();
  });
});

describe('restoreNoteVersion senza keyring', () => {
  it('nota vault legacy: invariato, titolo della versione', async () => {
    mp.note.findFirst.mockResolvedValue({ id: 'n1', content: LONG, title: 'T', isEncrypted: false, isVault: true });
    mp.vaultKeyring.findUnique.mockResolvedValue(null);
    setVersion('legacy-cipher');
    await restoreNoteVersion(U, 'n1', 'v1');
    expect(mp.note.update.mock.calls[0][0].data.title).toBe('Old title');
    expect(mp.note.update.mock.calls[0][0].data.content).toBe('legacy-cipher');
  });

  it('nota normale: vaultKeyring.findUnique non chiamato', async () => {
    mp.note.findFirst.mockResolvedValue({ id: 'n1', content: LONG, title: 'T', isEncrypted: false, isVault: false });
    setVersion('{"type":"doc","content":[]}');
    await restoreNoteVersion(U, 'n1', 'v1');
    expect(mp.vaultKeyring.findUnique).not.toHaveBeenCalled();
    expect(mp.note.update).toHaveBeenCalledTimes(1);
  });
});

describe('updateSharedNoteContent', () => {
  beforeEach(() => {
    mp.sharedNote.findUnique.mockResolvedValue({ status: 'ACCEPTED', permission: 'WRITE' });
    mp.note.findUnique.mockResolvedValue({ content: LONG, title: 'Old', isVault: false });
  });

  it('usa updateMany con isVault:false; count 1 -> ok', async () => {
    mp.note.updateMany.mockResolvedValue({ count: 1 });
    await expect(updateSharedNoteContent('user-2', 'n1', { title: 'New' })).resolves.toEqual({ ok: true });
    expect(mp.note.updateMany.mock.calls[0][0].where).toEqual({ id: 'n1', isVault: false });
    expect(mp.note.update).not.toHaveBeenCalled();
  });

  it('count 0 (nota spostata nel vault): 403', async () => {
    mp.note.updateMany.mockResolvedValue({ count: 0 });
    const e = await fail(updateSharedNoteContent('user-2', 'n1', { title: 'New' }));
    expect(e.statusCode).toBe(403);
    expect(e.message).toBe('errors.sharing.forbidden');
  });
});
