import crypto from 'crypto';
import fs from 'fs';
import bcrypt from 'bcrypt';
import { Prisma } from '@prisma/client';
import prisma from '../plugins/prisma';
import logger from '../utils/logger';
import { AppError } from '../utils/errors';
import { logEvent } from './audit.service';
import { getAttachmentPath } from './attachment.service';
import { codeHash, newCode } from './vaultRecovery.service';
import { pepperStatus } from './vault.service';
import { notifyReset, notifySuperadminsReset, type ResetEvent } from './vaultRecoveryNotify';

// Reset del vault (P3, spec docs/superpowers/plans/2026-11-26-vault-p3-reset-plan.md).
// Richiesta RESET: PENDING_CODE (10 min, 5 tentativi) -> WAITING (fino a resetScheduledAt) -> COMPLETED | CANCELLED (| EXPIRED).
// Keyring: READY -> RESET_PENDING -> NONE (epoch+1, riga conservata), oppure di nuovo READY se annullato.

const DAY_MS = 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
const WAIT_MS = 7 * DAY_MS;
const MAX_ATTEMPTS = 5;
const CODE_LEN = 12;
const OPEN_RECOVERY_STATES = ['PENDING_APPROVAL', 'PENDING_CODE', 'WAITING', 'RELEASED'] as const;

type Db = Prisma.TransactionClient | typeof prisma;
type Counts = { notes: number; tags: number; attachments: number };

const lock = (tx: Prisma.TransactionClient, userId: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'vault-reset:' + userId}))`;

// Il recapito non deve mai far fallire ne' rallentare una transizione gia' committata: parte in background.
function announce(userId: string, event: ResetEvent, args: { requestId: string; scheduledAt?: Date }, actorId: string): void {
  void (async () => {
    try { await notifyReset(userId, event, args); } catch { /* best effort */ }
    try { await notifySuperadminsReset(event, { requestId: args.requestId, ownerId: userId, actorId }); } catch { /* best effort */ }
  })();
}

function safeEqual(stored: string | null, expected: string): boolean {
  return stored !== null && stored.length === expected.length && crypto.timingSafeEqual(Buffer.from(stored), Buffer.from(expected));
}

// Maiuscole/minuscole e trattini/spazi indifferenti; alias Crockford (O->0, I/L->1).
function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

async function countContent(db: Db, userId: string): Promise<Counts> {
  const [notes, tags, attachments] = await Promise.all([
    db.note.count({ where: { userId, isVault: true } }),
    db.tag.count({ where: { userId, isVault: true } }),
    db.attachment.count({ where: { note: { userId, isVault: true } } }),
  ]);
  return { notes, tags, attachments };
}

export async function createResetChallenge(userId: string) {
  const requestId = crypto.randomUUID();
  const code = newCode().slice(0, CODE_LEN);
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await lock(tx, userId);
    const keyring = await tx.vaultKeyring.findUnique({ where: { userId }, select: { status: true } });
    if (keyring?.status !== 'READY') throw new AppError(409, 'errors.vault.notReady');
    // Una challenge nuova invalida la precedente.
    await tx.vaultRequest.updateMany({ where: { userId, type: 'RESET', status: 'PENDING_CODE' }, data: { status: 'EXPIRED' } });
    // Stato e hash nello stesso statement: mai una PENDING_CODE senza hash. Solo l'HMAC finisce nel DB.
    await tx.vaultRequest.create({
      data: { id: requestId, userId, type: 'RESET', status: 'PENDING_CODE', attempts: 0, expiresAt, codeHash: codeHash(requestId, 'R', code) },
    });
  });
  const counts = await countContent(prisma, userId);
  await logEvent(userId, 'vault.reset.challenge', { requestId });
  return { requestId, code, expiresAt: expiresAt.toISOString(), counts };
}

export async function confirmReset(userId: string, requestId: string, codeRaw: string, password: string) {
  // Il tentativo si consuma prima di verificare: codice e password sbagliati pesano uguale (5 in tutto).
  const bumped = await prisma.vaultRequest.updateMany({
    where: { id: requestId, userId, type: 'RESET', status: 'PENDING_CODE', attempts: { lt: MAX_ATTEMPTS }, expiresAt: { gt: new Date() } },
    data: { attempts: { increment: 1 } },
  });
  if (bumped.count !== 1) {
    const cur = await prisma.vaultRequest.findFirst({ where: { id: requestId, userId, type: 'RESET' }, select: { status: true, attempts: true, expiresAt: true } });
    const expired = !!cur && (cur.status === 'EXPIRED' || (cur.status === 'PENDING_CODE' && (cur.attempts >= MAX_ATTEMPTS || !cur.expiresAt || cur.expiresAt <= new Date())));
    throw expired ? new AppError(410, 'errors.vault.resetExpired') : new AppError(409, 'errors.vault.resetStateConflict');
  }
  const row = await prisma.vaultRequest.findUnique({ where: { id: requestId } });
  if (!row) throw new AppError(409, 'errors.vault.resetStateConflict');

  const fail = async (event: string, key: string): Promise<never> => {
    // Condizionata a PENDING_CODE: una conferma concorrente gia' arrivata a WAITING non va riportata a EXPIRED.
    if (row.attempts >= MAX_ATTEMPTS) await prisma.vaultRequest.updateMany({ where: { id: requestId, status: 'PENDING_CODE' }, data: { status: 'EXPIRED' } });
    await logEvent(userId, event, { requestId, attempts: row.attempts });
    throw new AppError(403, key); // mai 401: farebbe scattare il logout automatico
  };

  if (!safeEqual(row.codeHash, codeHash(requestId, 'R', normalizeCode(codeRaw)))) return fail('vault.reset.code_failed', 'errors.vault.resetInvalidCode');
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { password: true } });
  if (!user || !(await bcrypt.compare(password, user.password))) return fail('vault.reset.password_rejected', 'errors.vault.resetInvalidPassword');

  const scheduledAt = new Date(Date.now() + WAIT_MS);
  const counts = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await lock(tx, userId);
    const keyring = await tx.vaultKeyring.updateMany({ where: { userId, status: 'READY' }, data: { status: 'RESET_PENDING', resetScheduledAt: scheduledAt } });
    if (keyring.count !== 1) throw new AppError(409, 'errors.vault.resetStateConflict');
    const waiting = await tx.vaultRequest.updateMany({
      where: { id: requestId, userId, type: 'RESET', status: 'PENDING_CODE' },
      data: { status: 'WAITING', notBefore: scheduledAt, expiresAt: null, codeHash: null },
    });
    if (waiting.count !== 1) throw new AppError(409, 'errors.vault.resetStateConflict');
    // D7: un recupero aperto non convive con un reset; il materiale di rilascio non deve restare nel DB.
    await tx.vaultRequest.updateMany({
      where: { userId, type: 'RECOVERY', status: { in: [...OPEN_RECOVERY_STATES] } },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: userId, rootShareForClient: null, rootSignature: null },
    });
    return countContent(tx, userId);
  });
  await logEvent(userId, 'vault.reset.scheduled', { requestId, scheduledAt: scheduledAt.toISOString(), counts });
  announce(userId, 'scheduled', { requestId, scheduledAt }, userId);
  return { scheduledAt: scheduledAt.toISOString() };
}

// Annullo: keyring RESET_PENDING -> READY e richiesta WAITING -> CANCELLED, nella stessa transazione del job (stesso lock).
async function cancelFor(ownerId: string, actorId: string, knownRequestId?: string) {
  const requestId = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await lock(tx, ownerId);
    const keyring = await tx.vaultKeyring.updateMany({ where: { userId: ownerId, status: 'RESET_PENDING' }, data: { status: 'READY', resetScheduledAt: null } });
    if (keyring.count !== 1) throw new AppError(409, 'errors.vault.resetNotCancellable');
    const id = knownRequestId ?? (await tx.vaultRequest.findFirst({ where: { userId: ownerId, type: 'RESET', status: 'WAITING' }, orderBy: { createdAt: 'desc' }, select: { id: true } }))?.id;
    // Tutte le WAITING del proprietario, non solo `id`: un id vecchio non deve lasciare righe orfane.
    await tx.vaultRequest.updateMany({
      where: { userId: ownerId, type: 'RESET', status: 'WAITING' },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: actorId },
    });
    return id ?? null;
  });
  await logEvent(ownerId, 'vault.reset.cancelled', { requestId, byAdmin: actorId !== ownerId });
  announce(ownerId, 'cancelled', { requestId: requestId ?? '' }, actorId);
  return { ok: true as const };
}

export const cancelReset = (userId: string) => cancelFor(userId, userId);

export async function cancelResetByAdmin(adminId: string, requestId: string) {
  const row = await prisma.vaultRequest.findFirst({ where: { id: requestId, type: 'RESET' }, select: { id: true, userId: true, status: true } });
  if (!row) throw new AppError(404, 'errors.vault.recoveryNotFound');
  if (row.status !== 'WAITING') throw new AppError(409, 'errors.vault.resetNotCancellable');
  return cancelFor(row.userId, adminId, row.id);
}

// Campi crittografici e di stato azzerati dal reset: la riga resta (epoch durevole), il setup successivo la riusa (RT-10).
const WIPED_KEYRING = {
  status: 'NONE' as const,
  epoch: { increment: 1 },
  rev: { increment: 1 },
  kdf: null,
  kdfParams: Prisma.DbNull,
  pinSalt: null,
  wrappedVkPin: null,
  authVerifier: null,
  serverShareEnc: null,
  pepperKeyId: null,
  vkSigPub: null,
  wrappedVkSigKey: null,
  escrowBlob: null,
  sealedRootShare: null,
  rootKeyId: null,
  userShareUnderVk: null,
  prevVkWrap: null,
  failedAttempts: 0,
  lockedUntil: null,
  resetScheduledAt: null,
  migrationState: 'NONE' as const,
};

async function completeReset(userId: string): Promise<boolean> {
  const done = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Stesso ordine di conferma e annullo: prima l'advisory lock per utente, poi le righe.
    await lock(tx, userId);
    // 1. CAS: se il reset e' stato annullato o un altro worker l'ha gia' fatto, count 0 e non si cancella niente.
    const cas = await tx.vaultKeyring.updateMany({ where: { userId, status: 'RESET_PENDING', resetScheduledAt: { lte: new Date() } }, data: WIPED_KEYRING });
    if (cas.count !== 1) return null;
    const epoch = (await tx.vaultKeyring.findUnique({ where: { userId }, select: { epoch: true } }))?.epoch ?? null;
    // 2. url degli allegati prima che la cascata di FK li tolga.
    const urls = (await tx.attachment.findMany({ where: { note: { userId, isVault: true } }, select: { url: true } })).map((a) => a.url);
    // 3-4. Note (cestino compreso) e tag vault; NoteVersion, TagsOnNotes, Attachment, SharedNote, ChatMessage e AiConversation vanno in cascata per FK, Kanban va a null.
    const notes = await tx.note.deleteMany({ where: { userId, isVault: true } });
    const tags = await tx.tag.deleteMany({ where: { userId, isVault: true } });
    // 5. Richiesta COMPLETED.
    const request = await tx.vaultRequest.findFirst({ where: { userId, type: 'RESET', status: 'WAITING' }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    if (request) {
      await tx.vaultRequest.updateMany({ where: { id: request.id, userId, type: 'RESET', status: 'WAITING' }, data: { status: 'COMPLETED', completedAt: new Date() } });
    }
    // 6. Audit nella transazione (fa anche da stato per lastResetEpoch): create diretta, logEvent ingoierebbe l'errore.
    const counts: Counts = { notes: notes.count, tags: tags.count, attachments: urls.length };
    await tx.auditLog.create({ data: { userId, event: 'vault.reset.completed', details: { requestId: request?.id ?? null, epoch, counts } } });
    return { requestId: request?.id ?? '', urls };
  }, { timeout: 30000 });
  if (!done) return false;

  // Dopo il commit: unlink best effort (npm run prune resta la rete di sicurezza). Un file gia' assente non e' un errore.
  let filesFailed = 0;
  for (const url of done.urls) {
    try {
      await fs.promises.unlink(getAttachmentPath(url));
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      filesFailed += 1;
      logger.warn({ err, userId }, 'Vault reset: attachment file not removed');
    }
  }
  if (filesFailed > 0) await logEvent(userId, 'vault.reset.files_failed', { requestId: done.requestId, filesFailed });
  announce(userId, 'completed', { requestId: done.requestId }, userId);
  return true;
}

// Un reset in ritardo di oltre 1 ora non viene eseguito: il job gira ogni 15 minuti, quindi un ritardo simile significa che il backend (o il pepper) e' stato
// fuori uso e l'utente non ha potuto annullare. Si rinvia di 24 ore e si riavvisa.
const OVERDUE_MS = 60 * 60 * 1000;
const POSTPONE_MS = DAY_MS;

async function postponeReset(userId: string): Promise<boolean> {
  const now = Date.now();
  const next = new Date(now + POSTPONE_MS);
  const requestId = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await lock(tx, userId);
    // CAS condizionata: un annullo o un altro worker (che ha gia' spostato la data) fa count 0.
    const cas = await tx.vaultKeyring.updateMany({ where: { userId, status: 'RESET_PENDING', resetScheduledAt: { lt: new Date(now - OVERDUE_MS) } }, data: { resetScheduledAt: next } });
    if (cas.count !== 1) return null;
    const request = await tx.vaultRequest.findFirst({ where: { userId, type: 'RESET', status: 'WAITING' }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    await tx.vaultRequest.updateMany({ where: { userId, type: 'RESET', status: 'WAITING' }, data: { notBefore: next } });
    return request?.id ?? '';
  });
  if (requestId === null) return false;
  await logEvent(userId, 'vault.reset.postponed', { requestId, scheduledAt: next.toISOString() });
  announce(userId, 'scheduled', { requestId, scheduledAt: next }, userId);
  return true;
}

/** Hard delete dei reset scaduti (o di un solo utente, per l'hook E2E). Un errore non ferma gli altri utenti: il primo si rilancia alla fine. Ritorna quanti reset ha completato. */
export async function runResetJobs(opts: { userId?: string } = {}): Promise<number> {
  // Con il pepper assente o non valido ogni route vault (annullo compreso) risponde 503: non si cancella dove l'utente non puo' piu' annullare.
  if (pepperStatus().status !== 'ok') {
    logger.warn('Vault reset job skipped: VAULT_PEPPER_KEY missing or invalid');
    return 0;
  }
  let completed = 0;
  let firstError: unknown;
  let failed = false;
  const fail = (err: unknown) => { if (!failed) { failed = true; firstError = err; } };
  // Challenge abbandonate (codice scaduto mai confermato): nessun altro job le marca.
  try {
    await prisma.vaultRequest.updateMany({
      where: { type: 'RESET', status: 'PENDING_CODE', expiresAt: { lte: new Date() }, ...(opts.userId ? { userId: opts.userId } : {}) },
      data: { status: 'EXPIRED' },
    });
  } catch (err) { fail(err); }
  const now = Date.now();
  const due = await prisma.vaultKeyring.findMany({
    where: { status: 'RESET_PENDING', resetScheduledAt: { lte: new Date(now) }, ...(opts.userId ? { userId: opts.userId } : {}) },
    select: { userId: true, resetScheduledAt: true },
  });
  for (const { userId, resetScheduledAt } of due) {
    try {
      if (resetScheduledAt && resetScheduledAt.getTime() < now - OVERDUE_MS) await postponeReset(userId);
      else if (await completeReset(userId)) completed += 1;
    } catch (err) {
      fail(err);
    }
  }
  if (failed) throw firstError;
  return completed;
}
