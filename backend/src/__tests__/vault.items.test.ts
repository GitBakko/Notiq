import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/audit.service', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));

import prisma from '../plugins/prisma';
import { logEvent } from '../services/audit.service';
import { getItems, migrateItems, finalize, sha256hex } from '../services/vault.service';

const mp = prisma as any;
const U = 'user-1';
const EPOCH = 2;
const env = (epoch = EPOCH, tag = 'A') => `nv3.${epoch}.${tag.repeat(16)}.${'B'.repeat(30)}`;
const readyGuard = { status: 'READY', epoch: EPOCH };

async function fail(p: Promise<unknown>) {
  try {
    await p;
  } catch (e: any) {
    return e;
  }
  throw new Error('expected rejection');
}

beforeEach(() => {
  vi.clearAllMocks();
  mp.vaultKeyring.findUnique.mockResolvedValue(readyGuard);
});

describe('getItems', () => {
  const row = (id: string, content = 'x') => ({
    id, noteType: 'text', content, updatedAt: new Date(0), isTrashed: false,
  });

  it('con ids: where con userId, isVault e id in; next null; contentHash corretto', async () => {
    mp.note.findMany.mockResolvedValue([row('a', 'hello')]);
    const r = await getItems(U, { ids: ['a', 'b'] });
    expect(mp.note.findMany.mock.calls[0][0].where).toEqual({ userId: U, isVault: true, id: { in: ['a', 'b'] } });
    expect(r.next).toBeNull();
    expect(r.items[0].contentHash).toBe(sha256hex('hello'));
  });

  it('ids vuoto resta una query con in: []', async () => {
    mp.note.findMany.mockResolvedValue([]);
    const r = await getItems(U, { ids: [] });
    expect(mp.note.findMany.mock.calls[0][0].where.id).toEqual({ in: [] });
    expect(r.items).toEqual([]);
  });

  it('paginazione: 101 righe -> 100 item e next = id della 100esima', async () => {
    mp.note.findMany.mockResolvedValue(Array.from({ length: 101 }, (_, i) => row(`id${i}`)));
    const r = await getItems(U, {});
    expect(r.items).toHaveLength(100);
    expect(r.next).toBe('id99');
    const arg = mp.note.findMany.mock.calls[0][0];
    expect(arg.take).toBe(101);
    expect(arg.where).toEqual({ userId: U, isVault: true });
  });

  it('meno di 101 righe -> next null; after -> id gt', async () => {
    mp.note.findMany.mockResolvedValue([row('z')]);
    const r = await getItems(U, { after: 'abc' });
    expect(r.next).toBeNull();
    expect(mp.note.findMany.mock.calls[0][0].where).toEqual({ userId: U, isVault: true, id: { gt: 'abc' } });
  });

  it('userId vuoto -> throw', async () => {
    await expect(getItems('', {})).rejects.toThrow();
    expect(mp.note.findMany).not.toHaveBeenCalled();
  });
});

describe('migrateItems', () => {
  const cur40 = 'c'.repeat(40);
  const good = (id: string, baseHash = sha256hex(cur40)) => ({ id, baseHash, content: env(), noteType: 'text' });

  it('guard null o non ready -> 409, nessuna findFirst', async () => {
    mp.vaultKeyring.findUnique.mockResolvedValue(null);
    expect((await fail(migrateItems(U, [good('a')]))).statusCode).toBe(409);
    mp.vaultKeyring.findUnique.mockResolvedValue({ status: 'NONE', epoch: 1 });
    expect((await fail(migrateItems(U, [good('a')]))).statusCode).toBe(409);
    expect(mp.note.findFirst).not.toHaveBeenCalled();
  });

  it('ok: snapshot anche con 40 caratteri, data e where di updateMany, audit con soli conteggi', async () => {
    mp.note.findFirst.mockResolvedValue({ content: cur40, title: 'Titolo', noteType: 'text' });
    mp.note.updateMany.mockResolvedValue({ count: 1 });
    const item = good('a');
    const r = await migrateItems(U, [item]);
    expect(r.results).toEqual([{ id: 'a', status: 'ok' }]);
    expect(mp.note.findFirst.mock.calls[0][0].where).toEqual({ id: 'a', userId: U, isVault: true });
    expect(mp.noteVersion.create).toHaveBeenCalledWith({ data: { noteId: 'a', content: cur40, title: 'Titolo' } });
    const arg = mp.note.updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 'a', userId: U, isVault: true, content: cur40 });
    expect(arg.data).toEqual({ content: item.content, title: '', isEncrypted: true, searchText: null, ydocState: null });
    expect(logEvent).toHaveBeenCalledWith(U, 'vault.migrate', { ok: 1, already: 0, conflict: 0, notFound: 0, invalid: 0 });
  });

  it('due item, uno con baseHash sbagliato -> conflict, l\'altro ok, stesso ordine', async () => {
    mp.note.findFirst.mockResolvedValue({ content: cur40, title: 't', noteType: 'text' });
    mp.note.updateMany.mockResolvedValue({ count: 1 });
    const r = await migrateItems(U, [good('a', 'wrong'), good('b')]);
    expect(r.results).toEqual([{ id: 'a', status: 'conflict' }, { id: 'b', status: 'ok' }]);
    expect(mp.noteVersion.create).toHaveBeenCalledTimes(1);
    expect(logEvent).toHaveBeenCalledWith(U, 'vault.migrate', { ok: 1, already: 0, conflict: 1, notFound: 0, invalid: 0 });
  });

  it('secondo giro: contenuto gia envelope dell\'epoch corrente -> already, nessuna scrittura', async () => {
    mp.note.findFirst.mockResolvedValue({ content: env(), title: '', noteType: 'text' });
    const r = await migrateItems(U, [good('a')]);
    expect(r.results[0].status).toBe('already');
    expect(mp.noteVersion.create).not.toHaveBeenCalled();
    expect(mp.note.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ['noteType diverso', { noteType: 'kanban' }],
    ['plaintext', { content: 'plain text' }],
    ['epoch diversa', { content: env(EPOCH + 1) }],
  ])('invalid: %s', async (_n, patch) => {
    mp.note.findFirst.mockResolvedValue({ content: cur40, title: 't', noteType: 'text' });
    const r = await migrateItems(U, [{ ...good('a'), ...patch }]);
    expect(r.results[0].status).toBe('invalid');
    expect(mp.noteVersion.create).not.toHaveBeenCalled();
  });

  it('nota assente o altrui -> notFound', async () => {
    mp.note.findFirst.mockResolvedValue(null);
    const r = await migrateItems(U, [good('a')]);
    expect(r.results[0].status).toBe('notFound');
  });

  it('updateMany count 0 -> errore sentinella nella transazione, esito conflict', async () => {
    mp.note.findFirst.mockResolvedValue({ content: cur40, title: 't', noteType: 'text' });
    mp.note.updateMany.mockResolvedValue({ count: 0 });
    const spy = vi.spyOn(mp, '$transaction');
    const r = await migrateItems(U, [good('a')]);
    expect(r.results[0].status).toBe('conflict');
    await expect(spy.mock.results[0].value).rejects.toThrow();
  });

  it('userId vuoto -> throw, nessuna chiamata Prisma', async () => {
    await expect(migrateItems('', [good('a')])).rejects.toThrow();
    expect(mp.vaultKeyring.findUnique).not.toHaveBeenCalled();
    expect(mp.note.findFirst).not.toHaveBeenCalled();
    expect(mp.note.findMany).not.toHaveBeenCalled();
  });

  it('errori Prisma inattesi si propagano', async () => {
    mp.note.findFirst.mockRejectedValue(new Error('boom'));
    await expect(migrateItems(U, [good('a')])).rejects.toThrow('boom');
  });
});

describe('finalize', () => {
  it('guard non ready -> 409, nessuna query note', async () => {
    mp.vaultKeyring.findUnique.mockResolvedValue(null);
    expect((await fail(finalize(U, ['a']))).statusCode).toBe(409);
    expect(mp.note.findMany).not.toHaveBeenCalled();
  });

  it('keyring NONE -> 409 errors.vault.notReady, nessuna query note', async () => {
    mp.vaultKeyring.findUnique.mockResolvedValue({ status: 'NONE', epoch: 1 });
    const e = await fail(finalize(U, ['a']));
    expect(e.statusCode).toBe(409);
    expect(e.message).toBe('errors.vault.notReady');
    expect(mp.note.findMany).not.toHaveBeenCalled();
  });

  it('userId vuoto -> throw, nessuna chiamata Prisma', async () => {
    await expect(finalize('', ['a'])).rejects.toThrow();
    expect(mp.vaultKeyring.findUnique).not.toHaveBeenCalled();
    expect(mp.note.findFirst).not.toHaveBeenCalled();
    expect(mp.note.findMany).not.toHaveBeenCalled();
  });

  it('rejected: non-envelope, altra epoch, non posseduto, senza duplicati; deleteMany solo sugli accettati', async () => {
    mp.note.findMany.mockResolvedValue([
      { id: 'ok', content: env() },
      { id: 'plain', content: 'plaintext' },
      { id: 'old', content: env(EPOCH - 1) },
    ]);
    mp.note.count.mockResolvedValue(1);
    mp.vaultKeyring.findUnique.mockResolvedValueOnce(readyGuard).mockResolvedValueOnce({ migrationState: 'IN_PROGRESS' });
    const r = await finalize(U, ['ok', 'plain', 'old', 'foreign', 'foreign']);
    expect(mp.note.findMany.mock.calls[0][0].where).toEqual({ userId: U, isVault: true, id: { in: ['ok', 'plain', 'old', 'foreign', 'foreign'] } });
    expect(r.rejected).toEqual(['plain', 'old', 'foreign']);
    expect(r.finalized).toBe(1);
    expect(mp.noteVersion.deleteMany).toHaveBeenCalledWith({
      where: { noteId: { in: ['ok'] }, NOT: { content: { startsWith: 'nv3.' } } },
    });
    expect(logEvent).toHaveBeenCalledWith(U, 'vault.finalize', { finalized: 1, rejected: 3, legacyCount: 1 });
  });

  it('nessun accettato -> deleteMany non chiamato', async () => {
    mp.note.findMany.mockResolvedValue([]);
    mp.note.count.mockResolvedValue(0);
    mp.vaultKeyring.findUnique.mockResolvedValueOnce(readyGuard).mockResolvedValueOnce({ migrationState: 'NONE' });
    const r = await finalize(U, ['x']);
    expect(mp.noteVersion.deleteMany).not.toHaveBeenCalled();
    expect(r.finalized).toBe(0);
  });

  it('legacyCount 0 con IN_PROGRESS -> DONE', async () => {
    mp.note.findMany.mockResolvedValue([{ id: 'ok', content: env() }]);
    mp.note.count.mockResolvedValue(0);
    mp.vaultKeyring.findUnique.mockResolvedValueOnce(readyGuard).mockResolvedValueOnce({ migrationState: 'IN_PROGRESS' });
    const r = await finalize(U, ['ok']);
    expect(mp.vaultKeyring.updateMany).toHaveBeenCalledWith({
      where: { userId: U, migrationState: 'IN_PROGRESS' },
      data: { migrationState: 'DONE' },
    });
    expect(r.migrationState).toBe('DONE');
    expect(r.legacyCount).toBe(0);
  });

  it('legacyCount > 0 -> resta IN_PROGRESS', async () => {
    mp.note.findMany.mockResolvedValue([{ id: 'ok', content: env() }]);
    mp.note.count.mockResolvedValue(3);
    mp.vaultKeyring.findUnique.mockResolvedValueOnce(readyGuard).mockResolvedValueOnce({ migrationState: 'IN_PROGRESS' });
    const r = await finalize(U, ['ok']);
    expect(mp.vaultKeyring.updateMany).not.toHaveBeenCalled();
    expect(r.migrationState).toBe('IN_PROGRESS');
    expect(r.legacyCount).toBe(3);
  });
});
