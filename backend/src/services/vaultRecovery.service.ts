import crypto from 'crypto';
import type { z } from 'zod';
import type { Prisma } from '@prisma/client';
import prisma from '../plugins/prisma';
import { AppError } from '../utils/errors';
import { VAULT_ROOT_KEYS } from '../utils/vaultRootKeys';
import { logEvent } from './audit.service';
import { notifyRecovery, notifySuperadmins, type RecoveryEvent } from './vaultRecoveryNotify';
import { assertPointOnCurve, releaseRootShare, sealRecoveryCode } from './vaultRootKey.service';
import { authVerifierOf, keyringUpdatePayloadSchema, pepperStatus, sha256hex, verifierKey, verifyVkProof } from './vault.service';

const OPEN_STATES = ['PENDING_APPROVAL', 'PENDING_CODE', 'WAITING', 'RELEASED'] as const;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIMED_STATES = ['PENDING_APPROVAL', 'PENDING_CODE', 'WAITING'] as const; // scadono su expiresAt; RELEASED su releaseExpiresAt
const DAY_MS = 24 * 60 * 60 * 1000;

// FP = primi 40 bit di SHA-256(clientEphPub) in 8 cifre Crockford, bit piu' significativi per primi (spec §3.2.2).
export function fingerprintOf(pub: Uint8Array): string {
  const value = crypto.createHash('sha256').update(pub).digest().readUIntBE(0, 5);
  let out = '';
  for (let i = 7; i >= 0; i--) out += ALPHABET[Math.floor(value / 32 ** i) % 32];
  return out;
}

function safeEqual(stored: string | null, expected: string): boolean {
  return stored !== null && stored.length === expected.length && crypto.timingSafeEqual(Buffer.from(stored), Buffer.from(expected));
}

// Il recapito (SMTP, push) non deve mai far fallire ne' rallentare una transizione gia' committata: parte in background.
function notify(userId: string, event: RecoveryEvent, args: Parameters<typeof notifyRecovery>[2]): void {
  void (async () => { try { await notifyRecovery(userId, event, args); } catch { /* best effort */ } })();
}

function notifyAdminsInBackground(event: Parameters<typeof notifySuperadmins>[0], requestId: string, actorId: string): void {
  void (async () => { try { await notifySuperadmins(event, { requestId, actorId }); } catch { /* best effort */ } })();
}

function codeHash(requestId: string, part: 'A' | 'B', code: string): string {
  return crypto.createHmac('sha256', verifierKey()).update(`recovery|${requestId}|${part}|${code}`).digest('hex');
}

function newCode(): string {
  const bytes = crypto.randomBytes(16);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % 32];
  return `${out.slice(0, 8)}${out.slice(8, 16)}`;
}

const EXPIRY_REASON = { PENDING_APPROVAL: 'approval', PENDING_CODE: 'code', WAITING: 'waiting', RELEASED: 'release' } as const;

type LapsedRow = { id: string; userId: string; status: string };

/** Marca EXPIRED le richieste scadute per tempo (di un utente, o tutte). Per riga e condizionata a stato e scadenza letti: un approve/confirm/release/cancel concorrente vince e count e' 0. */
async function expireLapsed(db: Prisma.TransactionClient | typeof prisma, now: Date, userId?: string, onDone?: (row: LapsedRow) => Promise<void>): Promise<LapsedRow[]> {
  const candidates = await db.vaultRequest.findMany({
    where: {
      type: 'RECOVERY',
      ...(userId ? { userId } : {}),
      OR: [{ status: { in: [...TIMED_STATES] }, expiresAt: { lte: now } }, { status: 'RELEASED', releaseExpiresAt: { lte: now } }],
    },
    select: { id: true, userId: true, status: true, expiresAt: true, releaseExpiresAt: true },
  });
  const done: LapsedRow[] = [];
  // Con onDone (job, righe autocommit) ogni riga e' annunciata subito e un errore non ferma le altre: si rilancia il primo alla fine. Senza (dentro la transazione) il primo errore esce subito.
  let firstError: unknown;
  let failed = false;
  for (const c of candidates) {
    try {
      const released = c.status === 'RELEASED';
      const r = await db.vaultRequest.updateMany({
        where: { id: c.id, type: 'RECOVERY', status: c.status, ...(released ? { releaseExpiresAt: c.releaseExpiresAt } : { expiresAt: c.expiresAt }) },
        data: released ? { status: 'EXPIRED', rootShareForClient: null, rootSignature: null } : { status: 'EXPIRED' },
      });
      if (r.count === 1) {
        done.push(c);
        await onDone?.(c);
      }
    } catch (e) {
      if (!onDone) throw e;
      if (!failed) { failed = true; firstError = e; }
    }
  }
  if (failed) throw firstError;
  return done;
}

// Audit e notify solo per le righe davvero scadute da noi, e solo a transizione committata.
async function announceExpiredRow(c: LapsedRow): Promise<void> {
  await logEvent(c.userId, 'vault.recovery.expired', { requestId: c.id, reason: EXPIRY_REASON[c.status as keyof typeof EXPIRY_REASON] });
  notify(c.userId, 'expired', { requestId: c.id });
}

async function announceExpired(rows: LapsedRow[]): Promise<void> {
  for (const c of rows) await announceExpiredRow(c);
}

function assertPub(pub: Uint8Array): void {
  if (pub.length !== 97 || pub[0] !== 0x04) throw new AppError(400, 'errors.vault.invalidPayload');
  assertPointOnCurve(pub); // un punto fuori curva farebbe nascere una richiesta che l'approve non puo' mai sigillare
}

export async function createRecoveryRequest(userId: string, clientEphPub: Uint8Array, reason: string | undefined, requestIp: string, requestUserAgent: string) {
  assertPub(clientEphPub);
  const keyring = await prisma.vaultKeyring.findUnique({ where: { userId }, select: { status: true, sealedRootShare: true, rootKeyId: true } });
  if (!keyring || keyring.status !== 'READY' || !keyring.sealedRootShare || !keyring.rootKeyId) throw new AppError(409, 'errors.vault.recoveryNoKeyring');
  // Lock per utente: senza, richieste concorrenti passano tutte il controllo "nessuna aperta" e ne creano piu' d'una.
  let lapsed: LapsedRow[] = [];
  const row = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'vault-recovery:' + userId}))`;
    // Una richiesta scaduta per tempo ma non ancora marcata dal job non e' piu' aperta (il banner non la mostra): va scaduta qui, prima del controllo.
    lapsed = await expireLapsed(tx, new Date(), userId);
    const open = await tx.vaultRequest.findFirst({ where: { userId, type: 'RECOVERY', status: { in: [...OPEN_STATES] } }, select: { id: true } });
    if (open) throw new AppError(409, 'errors.vault.recoveryAlreadyOpen');
    // Quota: non contano annullate, rifiutate ed EXPIRED per tentativi esauriti (attempts >= 5); contano le EXPIRED per tempo.
    const recent = await tx.vaultRequest.count({
      where: { userId, type: 'RECOVERY', status: { notIn: ['CANCELLED', 'REJECTED'] }, NOT: { status: 'EXPIRED', attempts: { gte: 5 } }, createdAt: { gte: new Date(Date.now() - 30 * DAY_MS) } },
    });
    if (recent >= 3) throw new AppError(429, 'errors.vault.recoveryRateLimited');
    return tx.vaultRequest.create({
      data: {
        userId,
        type: 'RECOVERY',
        status: 'PENDING_APPROVAL',
        clientEphPub: Buffer.from(clientEphPub),
        fingerprint: fingerprintOf(clientEphPub),
        reason: reason?.slice(0, 500) || null,
        requestIp: requestIp.slice(0, 200),
        requestUserAgent: requestUserAgent.slice(0, 500),
        expiresAt: new Date(Date.now() + 7 * DAY_MS),
      },
    });
  });
  await announceExpired(lapsed);
  await logEvent(userId, 'vault.recovery.requested', { requestId: row.id, fingerprint: row.fingerprint });
  notify(userId, 'requested', { requestId: row.id, fingerprint: row.fingerprint ?? undefined });
  return { id: row.id, fingerprint: row.fingerprint };
}

export async function approveRecovery(adminId: string, requestId: string) {
  const row = await prisma.vaultRequest.findFirst({
    where: { id: requestId, type: 'RECOVERY', status: 'PENDING_APPROVAL', expiresAt: { gt: new Date() } },
    select: { userId: true, clientEphPub: true },
  });
  if (!row?.clientEphPub) throw new AppError(409, 'errors.vault.recoveryStateConflict');
  const code = newCode();
  const codeA = code.slice(0, 8);
  const codeB = code.slice(8);
  const sealedCodeA = sealRecoveryCode(codeA, row.clientEphPub, requestId, row.userId).toString('base64url');
  // Transizione e hash dei codici in un solo statement: mai una riga PENDING_CODE senza hash.
  const r = await prisma.vaultRequest.updateMany({
    where: { id: requestId, status: 'PENDING_APPROVAL', expiresAt: { gt: new Date() } },
    data: {
      status: 'PENDING_CODE', approvedById: adminId, approvedAt: new Date(), expiresAt: new Date(Date.now() + DAY_MS), attempts: 0,
      codeAHash: codeHash(requestId, 'A', codeA), codeBHash: codeHash(requestId, 'B', codeB),
    },
  });
  if (r.count !== 1) throw new AppError(409, 'errors.vault.recoveryStateConflict');
  const self = adminId === row.userId;
  await logEvent(adminId, 'vault.recovery.approved', self ? { requestId, self: true } : { requestId });
  if (self) notifyAdminsInBackground('selfAction', requestId, adminId);
  notify(row.userId, 'code', { requestId, codeB, sealedCodeA });
  return { status: 'PENDING_CODE' as const };
}

export async function rejectRecovery(adminId: string, requestId: string, reason: string) {
  const rejectReason = reason.slice(0, 500);
  const r = await prisma.vaultRequest.updateMany({
    where: { id: requestId, type: 'RECOVERY', status: 'PENDING_APPROVAL', expiresAt: { gt: new Date() } },
    data: { status: 'REJECTED', rejectReason },
  });
  if (r.count !== 1) throw new AppError(409, 'errors.vault.recoveryStateConflict');
  await logEvent(adminId, 'vault.recovery.rejected', { requestId });
  const row = await prisma.vaultRequest.findUnique({ where: { id: requestId }, select: { userId: true } });
  if (row) notify(row.userId, 'rejected', { requestId, reason: rejectReason });
  return { status: 'REJECTED' as const };
}

export async function confirmRecovery(userId: string, requestId: string, codeA: string, codeB: string) {
  const updated = await prisma.vaultRequest.updateMany({
    where: { id: requestId, userId, type: 'RECOVERY', status: 'PENDING_CODE', attempts: { lt: 5 }, expiresAt: { gt: new Date() } },
    data: { attempts: { increment: 1 } },
  });
  if (updated.count !== 1) {
    // Non tutti i conteggi 0 sono una scadenza: un retry dopo una risposta persa trova la richiesta gia' avanzata.
    const current = await prisma.vaultRequest.findFirst({ where: { id: requestId, userId, type: 'RECOVERY' }, select: { status: true, attempts: true, expiresAt: true } });
    if (!current) throw new AppError(404, 'errors.vault.recoveryNotFound');
    const expired = current.status === 'EXPIRED' || (current.status === 'PENDING_CODE' && (current.attempts >= 5 || !current.expiresAt || current.expiresAt <= new Date()));
    throw expired ? new AppError(410, 'errors.vault.recoveryExpired') : new AppError(409, 'errors.vault.recoveryStateConflict');
  }
  const row = await prisma.vaultRequest.findUnique({ where: { id: requestId } });
  if (!row) throw new AppError(404, 'errors.vault.recoveryNotFound');
  const validA = safeEqual(row.codeAHash, codeHash(requestId, 'A', codeA));
  const validB = safeEqual(row.codeBHash, codeHash(requestId, 'B', codeB));
  if (!validA || !validB) {
    // Condizionata a PENDING_CODE: un confirm concorrente gia' arrivato a WAITING non va riportato a EXPIRED.
    const exhausted = row.attempts >= 5 ? await prisma.vaultRequest.updateMany({ where: { id: requestId, status: 'PENDING_CODE' }, data: { status: 'EXPIRED' } }) : null;
    await logEvent(userId, 'vault.recovery.code_failed', { requestId, attempts: row.attempts });
    notify(userId, 'codeFailed', { requestId });
    if (exhausted?.count === 1) {
      await logEvent(userId, 'vault.recovery.expired', { requestId, reason: 'attempts' });
      notify(userId, 'expired', { requestId });
    }
    throw new AppError(403, 'errors.vault.recoveryInvalidCode');
  }
  const notBefore = new Date(Date.now() + 3 * DAY_MS);
  const waitingExpiresAt = new Date(notBefore.getTime() + 7 * DAY_MS); // spec §3.3 (tabella dei limiti): una WAITING non rilasciata entro 7 giorni da notBefore scade
  const waiting = await prisma.vaultRequest.updateMany({
    where: { id: requestId, userId, status: 'PENDING_CODE' },
    data: { status: 'WAITING', notBefore, expiresAt: waitingExpiresAt, codeAHash: null, codeBHash: null },
  });
  if (waiting.count !== 1) throw new AppError(409, 'errors.vault.recoveryStateConflict');
  await logEvent(userId, 'vault.recovery.confirmed', { requestId, notBefore: notBefore.toISOString() });
  notify(userId, 'waiting', { requestId, fingerprint: row.fingerprint ?? undefined, notBefore });
  return { status: 'WAITING' as const, notBefore };
}

export async function cancelRecovery(userId: string, requestId: string) {
  const now = new Date();
  const r = await prisma.vaultRequest.updateMany({
    // Anche il tempo: una scaduta non ancora marcata dal job finirebbe CANCELLED, che non conta nella quota, invece di EXPIRED.
    where: {
      id: requestId, userId, type: 'RECOVERY',
      OR: [{ status: { in: [...TIMED_STATES] }, expiresAt: { gt: now } }, { status: 'RELEASED', releaseExpiresAt: { gt: now } }],
    },
    data: { status: 'CANCELLED', cancelledAt: now, cancelledBy: userId, rootShareForClient: null, rootSignature: null },
  });
  if (r.count !== 1) {
    const current = await prisma.vaultRequest.findFirst({ where: { id: requestId, userId, type: 'RECOVERY' }, select: { status: true, expiresAt: true, releaseExpiresAt: true } });
    throw current && (current.status === 'EXPIRED' || isLapsed(current, now)) ? new AppError(410, 'errors.vault.recoveryExpired') : new AppError(409, 'errors.vault.recoveryStateConflict');
  }
  await logEvent(userId, 'vault.recovery.cancelled', { requestId });
  notify(userId, 'cancelled', { requestId });
  return { status: 'CANCELLED' as const };
}

async function checkReleaseRate(adminId: string): Promise<void> {
  const now = Date.now();
  const recent = await prisma.auditLog.count({ where: { userId: adminId, event: 'vault.recovery.release_failed', createdAt: { gte: new Date(now - 15 * 60 * 1000) } } });
  if (recent >= 3) throw new AppError(429, 'errors.vault.recoveryReleaseRateLimited');
  const daily = await prisma.auditLog.count({ where: { userId: adminId, event: 'vault.recovery.release_failed', createdAt: { gte: new Date(now - DAY_MS) } } });
  if (daily >= 10) throw new AppError(429, 'errors.vault.recoveryReleaseRateLimited');
}

export async function releaseRecovery(adminId: string, requestId: string, passphrase: string) {
  await checkReleaseRate(adminId);
  const row = await prisma.vaultRequest.findFirst({ where: { id: requestId, type: 'RECOVERY', status: 'WAITING', notBefore: { lte: new Date() }, expiresAt: { gt: new Date() } }, include: { user: { select: { vaultKeyring: true } } } });
  if (!row?.user.vaultKeyring?.sealedRootShare || !row.user.vaultKeyring.rootKeyId || !row.clientEphPub || !row.fingerprint || !row.notBefore) {
    throw new AppError(409, 'errors.vault.recoveryStateConflict');
  }
  // La firma copre row.fingerprint: va ricalcolato dalla chiave salvata prima di spendere Argon2id sul file root.
  if (fingerprintOf(row.clientEphPub) !== row.fingerprint) throw new AppError(409, 'errors.vault.recoveryFingerprintMismatch');
  let released: { rootShareForClient: Buffer; rootSignature: Buffer };
  try {
    released = await releaseRootShare({
      requestId,
      userId: row.userId,
      epoch: row.user.vaultKeyring.epoch,
      rootKeyId: row.user.vaultKeyring.rootKeyId,
      sealedRootShare: row.user.vaultKeyring.sealedRootShare,
      clientEphPub: row.clientEphPub,
      fingerprint: row.fingerprint,
      notBefore: row.notBefore,
      passphrase,
    });
  } catch (err) {
    // Solo la passphrase errata conta per il rate limit: 503 (file assente), 400 e 500 (firma) non sono tentativi.
    if (err instanceof AppError && err.message === 'errors.vault.invalidRootPassphrase') {
      await prisma.auditLog.create({ data: { userId: adminId, event: 'vault.recovery.release_failed', details: { requestId } } });
      notifyAdminsInBackground('releaseFailed', requestId, adminId);
    }
    throw err;
  }
  const changed = await prisma.vaultRequest.updateMany({
    where: { id: requestId, type: 'RECOVERY', status: 'WAITING', notBefore: { lte: new Date() }, expiresAt: { gt: new Date() } },
    data: {
      status: 'RELEASED',
      releasedById: adminId,
      releasedAt: new Date(),
      releaseExpiresAt: new Date(Date.now() + 7 * DAY_MS),
      rootShareForClient: Buffer.from(released.rootShareForClient),
      rootSignature: Buffer.from(released.rootSignature),
    },
  });
  if (changed.count !== 1) {
    released.rootShareForClient.fill(0);
    released.rootSignature.fill(0);
    throw new AppError(409, 'errors.vault.recoveryStateConflict');
  }
  const self = adminId === row.userId;
  await logEvent(adminId, 'vault.recovery.released', self ? { requestId, self: true } : { requestId });
  if (self) notifyAdminsInBackground('selfAction', requestId, adminId);
  notify(row.userId, 'released', { requestId });
  return { status: 'RELEASED' as const };
}

function isLapsed(row: { status: string; expiresAt?: Date | null; releaseExpiresAt?: Date | null }, now: Date): boolean {
  if (row.status === 'RELEASED') return !!row.releaseExpiresAt && row.releaseExpiresAt <= now;
  return (TIMED_STATES as readonly string[]).includes(row.status) && !!row.expiresAt && row.expiresAt <= now;
}

export async function getRecovery(userId: string, requestId: string) {
  const row = await prisma.vaultRequest.findFirst({ where: { id: requestId, userId, type: 'RECOVERY' } });
  if (!row) throw new AppError(404, 'errors.vault.recoveryNotFound');
  // Scaduta per tempo ma non ancora marcata dal job: si presenta gia' come EXPIRED, senza seal ne' codice (G7).
  const now = new Date();
  const status = isLapsed(row, now) ? 'EXPIRED' : row.status;
  const sealable = status === 'RELEASED' && !!row.releaseExpiresAt && row.releaseExpiresAt > now;
  // VaultRequest non ha una colonna per la meta A cifrata (G9): sta nella notifica `code` della richiesta.
  let sealedCodeA: string | null = null;
  if (status === 'PENDING_CODE') {
    const n = await prisma.notification.findFirst({
      where: { userId, type: 'VAULT_RECOVERY', AND: [{ data: { path: ['requestId'], equals: requestId } }, { data: { path: ['event'], equals: 'code' } }] },
      orderBy: { createdAt: 'desc' },
      select: { data: true },
    });
    const value = (n?.data as { sealedCodeA?: unknown } | null | undefined)?.sealedCodeA;
    sealedCodeA = typeof value === 'string' ? value : null;
  }
  return {
    status,
    fingerprint: row.fingerprint,
    notBefore: row.notBefore,
    releaseExpiresAt: row.releaseExpiresAt,
    sealedCodeA,
    rootShareForClient: sealable ? row.rootShareForClient : null,
    rootSignature: sealable ? row.rootSignature : null,
  };
}

export async function getOpenRecovery(userId: string) {
  const now = new Date();
  const row = await prisma.vaultRequest.findFirst({
    where: {
      userId, type: 'RECOVERY', status: { in: [...OPEN_STATES] },
      // Le scadute per tempo e non ancora marcate dal job non sono piu' aperte: il banner sparisce subito.
      AND: [{ OR: [{ status: { in: [...TIMED_STATES] }, expiresAt: { gt: now } }, { status: 'RELEASED', releaseExpiresAt: { gt: now } }] }],
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, fingerprint: true, createdAt: true, notBefore: true },
  });
  return row && { id: row.id, status: row.status, fingerprint: row.fingerprint, createdAt: row.createdAt, notBefore: row.notBefore };
}

const ADMIN_INCLUDE = { user: { select: { email: true, vaultKeyring: { select: { status: true, rootKeyId: true } } } } } as const;

// Vista admin: campi elencati a mano, cosi' un campo segreto aggiunto allo schema non esce per default.
type AdminRow = Prisma.VaultRequestGetPayload<{ include: typeof ADMIN_INCLUDE }>;

function adminView(row: AdminRow, now = new Date()) {
  // Scaduta per tempo ma non ancora marcata dal job: stesso criterio di getRecovery, mai "pronta" al rilascio.
  const status = isLapsed(row, now) ? 'EXPIRED' : row.status;
  return {
    id: row.id,
    userId: row.userId,
    userEmail: row.user?.email,
    status,
    fingerprint: row.fingerprint,
    reason: row.reason,
    requestIp: row.requestIp,
    requestUserAgent: row.requestUserAgent,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    notBefore: row.notBefore,
    approvedById: row.approvedById,
    approvedAt: row.approvedAt,
    rejectReason: row.rejectReason,
    releasedById: row.releasedById,
    releasedAt: row.releasedAt,
    releaseExpiresAt: row.releaseExpiresAt,
    completedAt: row.completedAt,
    cancelledAt: row.cancelledAt,
    keyringStatus: (row.user?.vaultKeyring?.status ?? null),
    rootKeyId: (row.user?.vaultKeyring?.rootKeyId ?? null),
    readyForRelease: status === 'WAITING' && !!row.notBefore && row.notBefore <= now,
  };
}

export async function listRecoveriesForAdmin(opts: { page: number; limit: number; status?: Prisma.VaultRequestWhereInput['status']; userId?: string }) {
  const where: Prisma.VaultRequestWhereInput = { type: 'RECOVERY', ...(opts.status ? { status: opts.status } : {}), ...(opts.userId ? { userId: opts.userId } : {}) };
  const [rows, total] = await Promise.all([
    prisma.vaultRequest.findMany({ where, include: ADMIN_INCLUDE, orderBy: { createdAt: 'desc' }, skip: (opts.page - 1) * opts.limit, take: opts.limit }),
    prisma.vaultRequest.count({ where }),
  ]);
  const now = new Date();
  return { items: rows.map((r) => adminView(r, now)), total, page: opts.page, limit: opts.limit };
}

export async function getRecoveryForAdmin(requestId: string) {
  const row = await prisma.vaultRequest.findFirst({ where: { id: requestId, type: 'RECOVERY' }, include: ADMIN_INCLUDE });
  if (!row) throw new AppError(404, 'errors.vault.recoveryNotFound');
  const audit = await prisma.auditLog.findMany({
    where: { details: { path: ['requestId'], equals: requestId } },
    orderBy: { createdAt: 'asc' },
    select: { event: true, userId: true, createdAt: true, details: true },
  });
  return { ...adminView(row), audit };
}

export async function completeRecovery(userId: string, requestId: string, payloadRaw: string, proof: Buffer) {
  const payloadHash = sha256hex(payloadRaw);
  const existing = await prisma.vaultRequest.findFirst({ where: { id: requestId, userId, type: 'RECOVERY' } });
  if (!existing) throw new AppError(404, 'errors.vault.recoveryNotFound');
  if (existing.status === 'COMPLETED' && existing.completedPayloadHash === payloadHash) return { status: 'COMPLETED' as const, idempotent: true };
  if (existing.status !== 'RELEASED' || !existing.releaseExpiresAt || existing.releaseExpiresAt <= new Date()) {
    throw new AppError(409, 'errors.vault.recoveryStateConflict');
  }
  let payload: z.infer<typeof keyringUpdatePayloadSchema>;
  try {
    const parsed = keyringUpdatePayloadSchema.safeParse(JSON.parse(payloadRaw));
    if (!parsed.success || parsed.data.rotate !== undefined || !parsed.data.wrap || !parsed.data.escrow) throw new Error('invalid'); // wrap ed escrow obbligatori (spec §3.2.7)
    payload = parsed.data;
  } catch {
    throw new AppError(400, 'errors.vault.invalidPayload');
  }

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const request = await tx.vaultRequest.findFirst({ where: { id: requestId, userId, status: 'RELEASED', releaseExpiresAt: { gt: new Date() } }, include: { user: { select: { vaultKeyring: true } } } });
    const keyring = request?.user.vaultKeyring;
    if (!request || !keyring || keyring.status !== 'READY') throw new AppError(409, 'errors.vault.recoveryStateConflict');
    verifyVkProof(keyring, 'POST', `/api/vault/recovery/${requestId}/complete`, payloadRaw, payload.rev, proof);
    if (payload.escrow && !Object.prototype.hasOwnProperty.call(VAULT_ROOT_KEYS, payload.escrow.rootKeyId)) throw new AppError(400, 'errors.vault.invalidRootKey');
    if (payload.wrap && keyring.pepperKeyId !== pepperStatus().keyId) throw new AppError(503, 'errors.vault.pepperMismatch');
    // U4: con il PIN nuovo, contatore dei tentativi e lockout dello sblocco ripartono da zero.
    const data: Prisma.VaultKeyringUpdateManyMutationInput = { rev: { increment: 1 }, failedAttempts: 0, lockedUntil: null };
    if (payload.wrap) {
      data.kdf = payload.wrap.kdf;
      data.kdfParams = payload.wrap.kdfParams;
      data.pinSalt = Buffer.from(payload.wrap.pinSalt, 'base64url');
      data.wrappedVkPin = Buffer.from(payload.wrap.wrappedVkPin, 'base64url');
      data.authVerifier = authVerifierOf(userId, Buffer.from(payload.wrap.authKey, 'base64url'));
      data.pepperKeyId = pepperStatus().keyId;
    }
    if (payload.escrow) {
      data.escrowBlob = Buffer.from(payload.escrow.escrowBlob, 'base64url');
      data.sealedRootShare = Buffer.from(payload.escrow.sealedRootShare, 'base64url');
      data.rootKeyId = payload.escrow.rootKeyId;
      data.userShareUnderVk = Buffer.from(payload.escrow.userShareUnderVk, 'base64url');
    }
    const changedKeyring = await tx.vaultKeyring.updateMany({ where: { userId, status: 'READY', epoch: keyring.epoch, rev: payload.rev }, data });
    if (changedKeyring.count !== 1) throw new AppError(409, 'errors.vault.staleRev');
    const changedRequest = await tx.vaultRequest.updateMany({
      where: { id: requestId, userId, status: 'RELEASED' },
      data: { status: 'COMPLETED', completedAt: new Date(), completedPayloadHash: payloadHash, rootShareForClient: null, rootSignature: null },
    });
    if (changedRequest.count !== 1) throw new AppError(409, 'errors.vault.recoveryStateConflict');
  });
  await logEvent(userId, 'vault.recovery.completed', { requestId });
  notify(userId, 'completed', { requestId });
  return { status: 'COMPLETED' as const, idempotent: false };
}

const REMINDER_LEAD_MS = DAY_MS;

export async function expireRecoveryRequests(now = new Date()) {
  const done = await expireLapsed(prisma, now, undefined, announceExpiredRow);
  return done.length;
}

/** Promemoria una tantum nelle 24 h prima di notBefore; il marker AuditLog (scritto nella stessa transazione del lock per richiesta, PRIMA della notifica) evita i doppioni fra run e worker. */
export async function sendRecoveryReminders(now = new Date()) {
  const due = await prisma.vaultRequest.findMany({
    where: { type: 'RECOVERY', status: 'WAITING', notBefore: { gt: now, lte: new Date(now.getTime() + REMINDER_LEAD_MS) } },
    select: { id: true, userId: true, fingerprint: true, notBefore: true },
  });
  let sent = 0;
  for (const r of due) {
    // Marker con create diretto (logEvent ingoia gli errori: senza marker la notify ripartirebbe a ogni run); lock try per richiesta contro il count-poi-insert fra worker.
    const marked = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${'vault-recovery-reminder:' + r.id})) AS locked`;
      if (!lock?.locked) return false;
      const already = await tx.auditLog.count({ where: { event: 'vault.recovery.reminder_sent', details: { path: ['requestId'], equals: r.id } } });
      if (already > 0) return false;
      await tx.auditLog.create({ data: { userId: r.userId, event: 'vault.recovery.reminder_sent', details: { requestId: r.id } } });
      return true;
    });
    if (!marked) continue;
    notify(r.userId, 'reminder', { requestId: r.id, fingerprint: r.fingerprint ?? undefined, notBefore: r.notBefore ?? undefined });
    sent += 1;
  }
  return sent;
}

/** Le due passate sono indipendenti: un errore della prima non salta la seconda; il primo errore viene rilanciato per il log del chiamante. */
export async function runRecoveryJobs() {
  let firstError: unknown;
  let expired = 0;
  let reminded = 0;
  try { expired = await expireRecoveryRequests(); } catch (err) { firstError = err; }
  try { reminded = await sendRecoveryReminders(); } catch (err) { firstError ??= err; }
  if (firstError !== undefined) throw firstError;
  return { expired, reminded };
}
