import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/email.service', () => ({ sendNotificationEmail: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/notification.service', () => ({ createNotification: vi.fn().mockResolvedValue({ id: 'n1' }) }));
vi.mock('../services/audit.service', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../utils/logger', () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import prisma from '../plugins/prisma';
import { sendNotificationEmail } from '../services/email.service';
import { createNotification } from '../services/notification.service';
import { notifyReset, notifySuperadminsReset } from '../services/vaultRecoveryNotify';
import { resolveNotification, VAULT_RESET_TEXTS } from '../utils/notificationI18n';

const mp = prisma as any;
const RID = 'req-1';
const when = new Date('2026-12-03T10:15:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sendNotificationEmail).mockResolvedValue(undefined);
  vi.mocked(createNotification).mockResolvedValue({ id: 'n1' } as any);
  mp.user.findUnique.mockResolvedValue({ email: 'u@example.com', locale: 'en' });
  mp.user.findMany.mockResolvedValue([]);
});

describe('notifyReset', () => {
  it('scheduled: notifica SYSTEM con chiave, data negli args e requestId; email col testo con la data', async () => {
    await notifyReset('user-1', 'scheduled', { requestId: RID, scheduledAt: when });
    const [uid, type, title, message, data] = vi.mocked(createNotification).mock.calls[0] as any[];
    expect(uid).toBe('user-1');
    expect(type).toBe('SYSTEM');
    expect(title).toBe(VAULT_RESET_TEXTS.scheduled.en.title);
    expect(message).toContain('2026-12-03 10:15 UTC');
    expect(data).toEqual({ localizationKey: 'notifications.vaultReset.scheduled', localizationArgs: { date: '2026-12-03 10:15 UTC' }, requestId: RID });
    const [to, mailType, payload] = vi.mocked(sendNotificationEmail).mock.calls[0] as any[];
    expect(to).toBe('u@example.com');
    expect(mailType).toBe('VAULT_RECOVERY');
    expect(payload.body).toContain('2026-12-03 10:15 UTC');
  });

  it.each(['cancelled', 'completed'] as const)('%s: nessun arg, testo italiano per locale it', async (event) => {
    mp.user.findUnique.mockResolvedValue({ email: 'u@example.com', locale: 'it-IT' });
    await notifyReset('user-1', event, { requestId: RID });
    const [, , title, , data] = vi.mocked(createNotification).mock.calls[0] as any[];
    expect(title).toBe(VAULT_RESET_TEXTS[event].it.title);
    expect(data).toEqual({ localizationKey: `notifications.vaultReset.${event}`, localizationArgs: {}, requestId: RID });
  });

  it('un errore SMTP o di notifica non lancia', async () => {
    vi.mocked(sendNotificationEmail).mockRejectedValue(new Error('smtp'));
    vi.mocked(createNotification).mockRejectedValue(new Error('db'));
    await expect(notifyReset('user-1', 'completed', { requestId: RID })).resolves.toBeUndefined();
    mp.user.findUnique.mockRejectedValue(new Error('db'));
    await expect(notifyReset('user-1', 'completed', { requestId: RID })).resolves.toBeUndefined();
  });
});

describe('notifySuperadminsReset', () => {
  it.each([['scheduled', 'adminScheduled'], ['cancelled', 'adminCancelled'], ['completed', 'adminCompleted']] as const)('%s: ogni SUPERADMIN tranne l attore, chiave %s con la mail del proprietario', async (event, key) => {
    mp.user.findUnique.mockResolvedValue({ email: 'owner@example.com' });
    mp.user.findMany.mockResolvedValue([{ id: 'a1', email: 'a1@example.com', locale: 'it' }]);
    await notifySuperadminsReset(event, { requestId: RID, ownerId: 'user-1', actorId: 'actor-1' });
    expect(mp.user.findMany.mock.calls[0][0].where).toEqual({ role: 'SUPERADMIN', id: { not: 'actor-1' } });
    const [uid, type, title, message, data] = vi.mocked(createNotification).mock.calls[0] as any[];
    expect(uid).toBe('a1');
    expect(type).toBe('SYSTEM');
    expect(title).toBe(VAULT_RESET_TEXTS[key].it.title);
    expect(message).toContain('owner@example.com');
    expect(data).toEqual({ localizationKey: `notifications.vaultReset.${key}`, localizationArgs: { email: 'owner@example.com' }, requestId: RID });
    expect(sendNotificationEmail).toHaveBeenCalledTimes(1);
  });

  it('un errore non lancia', async () => {
    mp.user.findUnique.mockRejectedValue(new Error('db'));
    await expect(notifySuperadminsReset('scheduled', { requestId: RID, ownerId: 'u', actorId: 'u' })).resolves.toBeUndefined();
  });
});

describe('testi del push', () => {
  it('ogni chiave notifications.vaultReset.* si risolve in it ed en, con titolo e interpolazione', () => {
    for (const ev of Object.keys(VAULT_RESET_TEXTS)) {
      for (const locale of ['en', 'it']) {
        const r = resolveNotification(`notifications.vaultReset.${ev}`, { date: 'D', email: 'E' }, locale, 'fallbackT', 'fallbackB');
        expect(r.title).toBe((VAULT_RESET_TEXTS as any)[ev][locale].title);
        expect(r.body).not.toContain('{{');
        expect(r.body).not.toBe('fallbackB');
      }
    }
  });

  it('nessun testo cita il codice di conferma', () => {
    expect(JSON.stringify(VAULT_RESET_TEXTS).toLowerCase()).not.toMatch(/\bcodice di conferma|confirmation code/);
  });
});
