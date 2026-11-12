import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/email.service', () => ({ sendNotificationEmail: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/notification.service', () => ({ createNotification: vi.fn().mockResolvedValue({ id: 'n1' }) }));
vi.mock('../services/audit.service', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../utils/logger', () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import prisma from '../plugins/prisma';
import logger from '../utils/logger';
import { sendNotificationEmail } from '../services/email.service';
import { createNotification } from '../services/notification.service';
import { logEvent } from '../services/audit.service';
import fs from 'fs';
import path from 'path';
import { notifyRecovery, notifySuperadmins, type RecoveryEvent } from '../services/vaultRecoveryNotify';
import { resolveNotification, VAULT_RECOVERY_TEXTS } from '../utils/notificationI18n';

const mp = prisma as any;
const U = 'user-1';
const RID = 'req-1';
const SENTINEL_B = 'SENTINELB';
const SEALED_A = 'sealed-code-a-b64url';

const EVENTS: RecoveryEvent[] = ['requested', 'code', 'codeFailed', 'waiting', 'reminder', 'released', 'completed', 'cancelled', 'rejected', 'expired'];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sendNotificationEmail).mockResolvedValue(undefined);
  vi.mocked(createNotification).mockResolvedValue({ id: 'n1' } as any);
  mp.user.findUnique.mockResolvedValue({ email: 'u@example.com', locale: 'en' });
  mp.user.findMany.mockResolvedValue([]);
});

const loggedText = () => JSON.stringify([...vi.mocked(logger.error).mock.calls, ...vi.mocked(logger.warn).mock.calls, ...vi.mocked(logger.info).mock.calls]);

describe('notifyRecovery', () => {
  it('code: una sola email con codeB, notifica con sealedCodeA e senza codeB', async () => {
    await notifyRecovery(U, 'code', { requestId: RID, codeB: SENTINEL_B, sealedCodeA: SEALED_A });

    expect(sendNotificationEmail).toHaveBeenCalledTimes(1);
    const [to, type, payload] = vi.mocked(sendNotificationEmail).mock.calls[0];
    expect(to).toBe('u@example.com');
    expect(type).toBe('VAULT_RECOVERY');
    expect(payload.codeB).toBe(SENTINEL_B);
    expect(payload.title).toBeTruthy();
    expect(payload.cta).toBeTruthy();

    expect(createNotification).toHaveBeenCalledTimes(1);
    const [uid, ntype, , , data] = vi.mocked(createNotification).mock.calls[0] as any[];
    expect(uid).toBe(U);
    expect(ntype).toBe('VAULT_RECOVERY');
    expect(data.sealedCodeA).toBe(SEALED_A);
    expect(data.requestId).toBe(RID);
    expect(data.event).toBe('code');
    expect(data.localizationKey).toBe('notifications.vaultRecovery.code');
    expect(Object.keys(data)).not.toContain('codeB');
    expect(JSON.stringify(vi.mocked(createNotification).mock.calls[0])).not.toContain(SENTINEL_B);
  });

  it('code: audit code_sent con emailOk/notificationOk e senza codici', async () => {
    await notifyRecovery(U, 'code', { requestId: RID, codeB: SENTINEL_B, sealedCodeA: SEALED_A });
    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent).toHaveBeenCalledWith(U, 'vault.recovery.code_sent', { requestId: RID, emailOk: true, notificationOk: true });
    expect(JSON.stringify(vi.mocked(logEvent).mock.calls)).not.toContain(SENTINEL_B);
    expect(JSON.stringify(vi.mocked(logEvent).mock.calls)).not.toContain(SEALED_A);
  });

  it('un errore SMTP non lancia e la notifica parte comunque', async () => {
    vi.mocked(sendNotificationEmail).mockRejectedValueOnce(new Error('SMTP down'));
    await expect(notifyRecovery(U, 'code', { requestId: RID, codeB: SENTINEL_B, sealedCodeA: SEALED_A })).resolves.toBeUndefined();
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(logEvent).toHaveBeenCalledWith(U, 'vault.recovery.code_sent', { requestId: RID, emailOk: false, notificationOk: true });
    expect(logger.error).toHaveBeenCalled();
  });

  it('un errore di createNotification non lancia e l\'email parte comunque', async () => {
    vi.mocked(createNotification).mockRejectedValueOnce(new Error('db down'));
    await expect(notifyRecovery(U, 'code', { requestId: RID, codeB: SENTINEL_B, sealedCodeA: SEALED_A })).resolves.toBeUndefined();
    expect(sendNotificationEmail).toHaveBeenCalledTimes(1);
    expect(logEvent).toHaveBeenCalledWith(U, 'vault.recovery.code_sent', { requestId: RID, emailOk: true, notificationOk: false });
  });

  it('la sentinella di codeB non compare nei log, nemmeno sugli errori', async () => {
    vi.mocked(sendNotificationEmail).mockRejectedValueOnce(new Error('SMTP down'));
    vi.mocked(createNotification).mockRejectedValueOnce(new Error('db down'));
    await notifyRecovery(U, 'code', { requestId: RID, codeB: SENTINEL_B, sealedCodeA: SEALED_A });
    expect(loggedText()).not.toContain(SENTINEL_B);
    expect(loggedText()).not.toContain(SEALED_A);
  });

  it('utente inesistente: non lancia e non invia nulla', async () => {
    mp.user.findUnique.mockResolvedValue(null);
    await expect(notifyRecovery(U, 'requested', { requestId: RID })).resolves.toBeUndefined();
    expect(sendNotificationEmail).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('errore del DB sul caricamento utente: non lancia', async () => {
    mp.user.findUnique.mockRejectedValue(new Error('db down'));
    await expect(notifyRecovery(U, 'requested', { requestId: RID })).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });

  it('locale it: testi italiani in email e notifica', async () => {
    mp.user.findUnique.mockResolvedValue({ email: 'u@example.com', locale: 'it' });
    await notifyRecovery(U, 'released', { requestId: RID });
    const email = vi.mocked(sendNotificationEmail).mock.calls[0][2];
    expect(email.title).toBe('Recupero rilasciato');
    expect(email.cta).toBe('Apri Notiq');
    const notif = vi.mocked(createNotification).mock.calls[0] as any[];
    expect(notif[2]).toBe('Recupero rilasciato');
  });

  it('locale en (o sconosciuto): testi inglesi', async () => {
    mp.user.findUnique.mockResolvedValue({ email: 'u@example.com', locale: 'de' });
    await notifyRecovery(U, 'released', { requestId: RID });
    expect(vi.mocked(sendNotificationEmail).mock.calls[0][2].title).toBe('Recovery released');
  });

  it('waiting: fingerprint e notBefore nel corpo email, fingerprint in localizationArgs', async () => {
    await notifyRecovery(U, 'waiting', { requestId: RID, fingerprint: 'ABCD1234', notBefore: new Date('2026-12-01T10:30:00.000Z') });
    const body = vi.mocked(sendNotificationEmail).mock.calls[0][2].body;
    expect(body).toContain('ABCD1234');
    expect(body).toContain('2026-12-01 10:30 UTC');
    const data = (vi.mocked(createNotification).mock.calls[0] as any[])[4];
    expect(data.localizationArgs).toEqual({ fingerprint: 'ABCD1234' });
    expect(data.sealedCodeA).toBeUndefined();
  });

  it('eventi diversi da code: nessun audit code_sent, nessun codeB in email', async () => {
    await notifyRecovery(U, 'requested', { requestId: RID, fingerprint: 'ABCD1234' });
    expect(logEvent).not.toHaveBeenCalled();
    expect(vi.mocked(sendNotificationEmail).mock.calls[0][2].codeB).toBeUndefined();
  });

  it('F9: rejected -> il motivo dell\'admin e\' nel corpo email (en e it), non nella notifica', async () => {
    await notifyRecovery(U, 'rejected', { requestId: RID, reason: 'Identity not verified' });
    expect(vi.mocked(sendNotificationEmail).mock.calls[0][2].body).toContain('Identity not verified');
    expect(JSON.stringify(vi.mocked(createNotification).mock.calls[0])).not.toContain('Identity not verified');

    vi.clearAllMocks();
    mp.user.findUnique.mockResolvedValue({ email: 'u@example.com', locale: 'it' });
    await notifyRecovery(U, 'rejected', { requestId: RID, reason: 'Identita non verificata' });
    const body = vi.mocked(sendNotificationEmail).mock.calls[0][2].body;
    expect(body).toContain('Identita non verificata');
    expect(body).toContain('Motivo');
  });

  it('F9: rejected senza motivo -> nessun suffisso Reason', async () => {
    await notifyRecovery(U, 'rejected', { requestId: RID });
    expect(vi.mocked(sendNotificationEmail).mock.calls[0][2].body).not.toContain('Reason');
  });

  it.each(['requested', 'waiting'] as const)('F10: %s -> il fingerprint e\' nel corpo di notifica ed email, senza segnaposto residui', async (ev) => {
    await notifyRecovery(U, ev, { requestId: RID, fingerprint: 'ABCD1234', notBefore: ev === 'waiting' ? new Date('2026-12-01T10:30:00.000Z') : undefined });
    const notifBody = (vi.mocked(createNotification).mock.calls[0] as any[])[3] as string;
    const mailBody = vi.mocked(sendNotificationEmail).mock.calls[0][2].body;
    for (const b of [notifBody, mailBody]) {
      expect(b).toContain('ABCD1234');
      expect(b).not.toContain('{{');
    }
    expect(mailBody.split('ABCD1234')).toHaveLength(2); // una sola volta
    const data = (vi.mocked(createNotification).mock.calls[0] as any[])[4];
    expect(data.localizationArgs).toEqual({ fingerprint: 'ABCD1234' });
  });

  it.each(['requested', 'waiting'] as const)('F10: %s -> il testo push/in-app risolto contiene il fingerprint (en e it) e i JSON frontend hanno lo stesso segnaposto', (ev) => {
    for (const lang of ['en', 'it'] as const) {
      const resolved = resolveNotification(`notifications.vaultRecovery.${ev}`, { fingerprint: 'ABCD1234' }, lang, 't', 'b');
      expect(resolved.body).toContain('ABCD1234');
      expect(resolved.body).not.toContain('{{');
      const json = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../../frontend/src/locales/${lang}.json`), 'utf8'));
      expect(json.notifications.vaultRecovery[ev]).toBe(VAULT_RECOVERY_TEXTS[ev][lang].body);
      expect(json.notifications.vaultRecovery[ev]).toContain('{{fingerprint}}');
    }
  });

  it.each(EVENTS)('evento %s: email e notifica con localizationKey corretta', async (ev) => {
    await notifyRecovery(U, ev, { requestId: RID, codeB: ev === 'code' ? SENTINEL_B : undefined, sealedCodeA: ev === 'code' ? SEALED_A : undefined });
    expect(sendNotificationEmail).toHaveBeenCalledTimes(1);
    const data = (vi.mocked(createNotification).mock.calls[0] as any[])[4];
    expect(data.localizationKey).toBe(`notifications.vaultRecovery.${ev}`);
    expect(data.event).toBe(ev);
  });
});

describe('notifySuperadmins', () => {
  const admins = [{ email: 'a1@example.com', locale: 'en' }, { email: 'a2@example.com', locale: 'it' }];

  it('selfAction: esclude l\'attore e invia a tutti gli altri nel loro locale', async () => {
    mp.user.findUnique.mockResolvedValue({ email: 'actor@example.com' });
    mp.user.findMany.mockResolvedValue(admins);
    await notifySuperadmins('selfAction', { requestId: RID, actorId: 'admin-9' });

    const where = mp.user.findMany.mock.calls[0][0].where;
    expect(where.role).toBe('SUPERADMIN');
    expect(where.id).toEqual({ not: 'admin-9' });
    expect(sendNotificationEmail).toHaveBeenCalledTimes(2);
    const [to1, type1, p1] = vi.mocked(sendNotificationEmail).mock.calls[0];
    const [to2, , p2] = vi.mocked(sendNotificationEmail).mock.calls[1];
    expect(to1).toBe('a1@example.com');
    expect(type1).toBe('VAULT_RECOVERY');
    expect(to2).toBe('a2@example.com');
    for (const p of [p1, p2]) {
      expect(p.body).toContain(RID);
      expect(p.body).toContain('actor@example.com');
      expect(p.codeB).toBeUndefined();
    }
    expect(p1.title).not.toBe(p2.title);
  });

  it('releaseFailed: include tutti i SUPERADMIN, attore compreso', async () => {
    mp.user.findUnique.mockResolvedValue({ email: 'actor@example.com' });
    mp.user.findMany.mockResolvedValue(admins);
    await notifySuperadmins('releaseFailed', { requestId: RID, actorId: 'admin-9' });
    const where = mp.user.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ role: 'SUPERADMIN' });
    expect(sendNotificationEmail).toHaveBeenCalledTimes(2);
  });

  it('un errore SMTP su un destinatario non blocca gli altri e non lancia', async () => {
    mp.user.findUnique.mockResolvedValue({ email: 'actor@example.com' });
    mp.user.findMany.mockResolvedValue(admins);
    vi.mocked(sendNotificationEmail).mockRejectedValueOnce(new Error('SMTP down'));
    await expect(notifySuperadmins('releaseFailed', { requestId: RID, actorId: 'admin-9' })).resolves.toBeUndefined();
    expect(sendNotificationEmail).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalled();
  });

  it('errore del DB: non lancia', async () => {
    mp.user.findUnique.mockRejectedValue(new Error('db down'));
    mp.user.findMany.mockRejectedValue(new Error('db down'));
    await expect(notifySuperadmins('selfAction', { requestId: RID, actorId: 'admin-9' })).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
});
