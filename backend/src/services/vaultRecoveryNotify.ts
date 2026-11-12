import prisma from '../plugins/prisma';
import logger from '../utils/logger';
import { logEvent } from './audit.service';
import { createNotification } from './notification.service';
import { sendNotificationEmail } from './email.service';
import { VAULT_RECOVERY_TEXTS } from '../utils/notificationI18n';

export type RecoveryEvent = 'requested' | 'code' | 'codeFailed' | 'waiting' | 'reminder' | 'released' | 'completed' | 'cancelled' | 'rejected' | 'expired';

type Locale = 'en' | 'it';

const LABELS: Record<Locale, { cta: string; fp: string; notBefore: string; codeB: string; reason: string }> = {
  en: { cta: 'Open Notiq', reason: 'Reason', fp: 'Request code', notBefore: 'Available from', codeB: 'The second half of the code is shown below.' },
  it: { cta: 'Apri Notiq', reason: 'Motivo', fp: 'Codice richiesta', notBefore: 'Disponibile da', codeB: 'La seconda metà del codice è riportata qui sotto.' },
};

const ADMIN_TEXTS: Record<'releaseFailed' | 'selfAction', Record<Locale, { title: string; body: (requestId: string, actor: string) => string }>> = {
  releaseFailed: {
    en: { title: 'Vault recovery: release failed', body: (r, a) => `A wrong root passphrase was entered by ${a} while releasing recovery request ${r}.` },
    it: { title: 'Recupero vault: rilascio fallito', body: (r, a) => `${a} ha inserito una passphrase root errata rilasciando la richiesta di recupero ${r}.` },
  },
  selfAction: {
    en: { title: 'Vault recovery: self-action', body: (r, a) => `${a} acted on their own vault recovery request ${r}.` },
    it: { title: 'Recupero vault: azione su se stessi', body: (r, a) => `${a} ha agito sulla propria richiesta di recupero del vault ${r}.` },
  },
};

const localeOf = (l: string | null | undefined): Locale => (l && l.startsWith('it') ? 'it' : 'en');
const utc = (d: Date) => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

// Never throws and never logs args: they may carry the second half of the recovery code.
export async function notifyRecovery(
  userId: string,
  event: RecoveryEvent,
  args: { requestId: string; fingerprint?: string; notBefore?: Date; codeB?: string; sealedCodeA?: string; reason?: string },
): Promise<void> {
  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, locale: true } });
    if (!user) return;
    const lang = localeOf(user.locale);
    const { title, body } = VAULT_RECOVERY_TEXTS[event][lang];
    const labels = LABELS[lang];

    // requested/waiting portano il segnaposto {{fingerprint}} nel testo; gli altri eventi lo aggiungono in coda alla sola email.
    const hasFpPlaceholder = body.includes('{{fingerprint}}');
    const text = body.replace(/\{\{fingerprint\}\}/g, args.fingerprint ?? '-');
    let emailBody = text;
    if (args.fingerprint && !hasFpPlaceholder) emailBody += ` ${labels.fp}: ${args.fingerprint}.`;
    if (event === 'rejected' && args.reason) emailBody += ` ${labels.reason}: ${args.reason}`;
    if (args.notBefore) emailBody += ` ${labels.notBefore}: ${utc(args.notBefore)}.`;
    if (args.codeB) emailBody += ` ${labels.codeB}`;

    // codeB goes only into the email: never into the notification data (persisted, pushed) nor into logs.
    const data = {
      localizationKey: `notifications.vaultRecovery.${event}`,
      localizationArgs: args.fingerprint ? { fingerprint: args.fingerprint } : {},
      requestId: args.requestId,
      event,
      ...(args.sealedCodeA ? { sealedCodeA: args.sealedCodeA } : {}),
    };

    const [notif, mail] = await Promise.allSettled([
      createNotification(userId, 'VAULT_RECOVERY', title, text, data),
      sendNotificationEmail(user.email, 'VAULT_RECOVERY', { title, body: emailBody, cta: labels.cta, ...(args.codeB ? { codeB: args.codeB } : {}) }),
    ]);
    if (notif.status === 'rejected') logger.error({ err: notif.reason, requestId: args.requestId }, 'Vault recovery notification failed');
    if (mail.status === 'rejected') logger.error({ err: mail.reason, requestId: args.requestId }, 'Vault recovery email failed');

    if (event === 'code') {
      await logEvent(userId, 'vault.recovery.code_sent', { requestId: args.requestId, emailOk: mail.status === 'fulfilled', notificationOk: notif.status === 'fulfilled' });
    }
  } catch (err) {
    logger.error({ err, requestId: args.requestId }, 'Vault recovery notify failed');
  }
}

export async function notifySuperadmins(event: 'releaseFailed' | 'selfAction', args: { requestId: string; actorId: string }): Promise<void> {
  try {
    const [actor, admins] = await Promise.all([
      prisma.user.findUnique({ where: { id: args.actorId }, select: { email: true } }),
      // selfAction: the actor already knows; releaseFailed: everyone, actor included.
      prisma.user.findMany({ where: { role: 'SUPERADMIN', ...(event === 'selfAction' ? { id: { not: args.actorId } } : {}) }, select: { email: true, locale: true } }),
    ]);
    const actorEmail = actor?.email ?? args.actorId;
    await Promise.all(admins.map(async (a) => {
      const lang = localeOf(a.locale);
      const t = ADMIN_TEXTS[event][lang];
      try {
        await sendNotificationEmail(a.email, 'VAULT_RECOVERY', { title: t.title, body: t.body(args.requestId, actorEmail), cta: LABELS[lang].cta });
      } catch (err) {
        logger.error({ err, requestId: args.requestId }, 'Vault recovery superadmin email failed');
      }
    }));
  } catch (err) {
    logger.error({ err, requestId: args.requestId }, 'Vault recovery notifySuperadmins failed');
  }
}
