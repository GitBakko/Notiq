import crypto from 'crypto';
import type { z } from 'zod';
import type { Prisma } from '@prisma/client';
import prisma from '../plugins/prisma';
import { AppError } from '../utils/errors';
import { VAULT_ROOT_KEYS } from '../utils/vaultRootKeys';
import { logEvent } from './audit.service';
import { releaseRootShare } from './vaultRootKey.service';
import { authVerifierOf, keyringUpdatePayloadSchema, pepperStatus, sha256hex, verifierKey, verifyVkProof } from './vault.service';

const OPEN_STATES = ['PENDING_APPROVAL', 'PENDING_CODE', 'WAITING', 'RELEASED'] as const;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const DAY_MS = 24 * 60 * 60 * 1000;

function fingerprintOf(pub: Uint8Array): string {
  const digest = crypto.createHash('sha256').update(pub).digest();
  let value = digest.readUInt32BE(0);
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += ALPHABET[value % 32];
    value = Math.floor(value / 32);
  }
  return out;
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

function assertPub(pub: Uint8Array): void {
  if (pub.length !== 97 || pub[0] !== 0x04) throw new AppError(400, 'errors.vault.invalidPayload');
}

export async function createRecoveryRequest(userId: string, clientEphPub: Uint8Array, reason: string | undefined, requestIp: string, requestUserAgent: string) {
  assertPub(clientEphPub);
  const open = await prisma.vaultRequest.findFirst({ where: { userId, type: 'RECOVERY', status: { in: [...OPEN_STATES] } }, select: { id: true } });
  if (open) throw new AppError(409, 'errors.vault.recoveryAlreadyOpen');
  const recent = await prisma.vaultRequest.count({ where: { userId, type: 'RECOVERY', status: { notIn: ['CANCELLED', 'REJECTED'] }, createdAt: { gte: new Date(Date.now() - 30 * DAY_MS) } } });
  if (recent >= 3) throw new AppError(429, 'errors.vault.recoveryRateLimited');
  const row = await prisma.vaultRequest.create({
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
  await logEvent(userId, 'vault.recovery.requested', { requestId: row.id, fingerprint: row.fingerprint });
  return { id: row.id, fingerprint: row.fingerprint };
}

export async function approveRecovery(adminId: string, requestId: string) {
  const r = await prisma.vaultRequest.updateMany({
    where: { id: requestId, status: 'PENDING_APPROVAL', expiresAt: { gt: new Date() } },
    data: { status: 'PENDING_CODE', approvedById: adminId, approvedAt: new Date(), expiresAt: new Date(Date.now() + DAY_MS), attempts: 0 },
  });
  if (r.count !== 1) throw new AppError(409, 'errors.vault.recoveryStateConflict');
  const code = newCode();
  const codeA = code.slice(0, 8);
  const codeB = code.slice(8);
  await prisma.vaultRequest.update({ where: { id: requestId }, data: { codeAHash: codeHash(requestId, 'A', codeA), codeBHash: codeHash(requestId, 'B', codeB) } });
  await logEvent(adminId, 'vault.recovery.approved', { requestId });
  return { codeA, codeB };
}

export async function confirmRecovery(userId: string, requestId: string, codeA: string, codeB: string) {
  const updated = await prisma.vaultRequest.updateMany({
    where: { id: requestId, userId, type: 'RECOVERY', status: 'PENDING_CODE', attempts: { lt: 5 }, expiresAt: { gt: new Date() } },
    data: { attempts: { increment: 1 } },
  });
  if (updated.count !== 1) throw new AppError(410, 'errors.vault.recoveryExpired');
  const row = await prisma.vaultRequest.findUnique({ where: { id: requestId } });
  if (!row) throw new AppError(404, 'errors.vault.recoveryNotFound');
  const valid = crypto.timingSafeEqual(Buffer.from(row.codeAHash ?? ''), Buffer.from(codeHash(requestId, 'A', codeA)))
    && crypto.timingSafeEqual(Buffer.from(row.codeBHash ?? ''), Buffer.from(codeHash(requestId, 'B', codeB)));
  if (!valid) {
    if (row.attempts >= 5) await prisma.vaultRequest.update({ where: { id: requestId }, data: { status: 'EXPIRED' } });
    await logEvent(userId, 'vault.recovery.code_failed', { requestId, attempts: row.attempts });
    throw new AppError(403, 'errors.vault.recoveryInvalidCode');
  }
  const notBefore = new Date(Date.now() + 3 * DAY_MS);
  const waiting = await prisma.vaultRequest.updateMany({
    where: { id: requestId, userId, status: 'PENDING_CODE' },
    data: { status: 'WAITING', notBefore, codeAHash: null, codeBHash: null },
  });
  if (waiting.count !== 1) throw new AppError(409, 'errors.vault.recoveryStateConflict');
  await logEvent(userId, 'vault.recovery.confirmed', { requestId, notBefore: notBefore.toISOString() });
  return { status: 'WAITING' as const, notBefore };
}

export async function cancelRecovery(userId: string, requestId: string) {
  const r = await prisma.vaultRequest.updateMany({
    where: { id: requestId, userId, type: 'RECOVERY', status: { in: [...OPEN_STATES] } },
    data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: userId, rootShareForClient: null, rootSignature: null },
  });
  if (r.count !== 1) throw new AppError(409, 'errors.vault.recoveryStateConflict');
  await logEvent(userId, 'vault.recovery.cancelled', { requestId });
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
  const row = await prisma.vaultRequest.findFirst({ where: { id: requestId, status: 'WAITING', notBefore: { lte: new Date() } }, include: { user: { select: { vaultKeyring: true } } } });
  if (!row?.user.vaultKeyring?.sealedRootShare || !row.user.vaultKeyring.rootKeyId || !row.clientEphPub || !row.fingerprint || !row.notBefore) {
    throw new AppError(409, 'errors.vault.recoveryStateConflict');
  }
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
    await prisma.auditLog.create({ data: { userId: adminId, event: 'vault.recovery.release_failed', details: { requestId } } });
    throw err;
  }
  const changed = await prisma.vaultRequest.updateMany({
    where: { id: requestId, status: 'WAITING', notBefore: { lte: new Date() } },
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
  await logEvent(adminId, 'vault.recovery.released', { requestId });
  return { status: 'RELEASED' as const };
}

export async function getRecovery(userId: string, requestId: string) {
  const row = await prisma.vaultRequest.findFirst({ where: { id: requestId, userId, type: 'RECOVERY' } });
  if (!row) throw new AppError(404, 'errors.vault.recoveryNotFound');
  return {
    status: row.status,
    fingerprint: row.fingerprint,
    notBefore: row.notBefore,
    releaseExpiresAt: row.releaseExpiresAt,
    rootShareForClient: row.status === 'RELEASED' ? row.rootShareForClient : null,
    rootSignature: row.status === 'RELEASED' ? row.rootSignature : null,
  };
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
    if (!parsed.success || parsed.data.rotate !== undefined) throw new Error('invalid');
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
    const data: Prisma.VaultKeyringUpdateManyMutationInput = { rev: { increment: 1 } };
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
  return { status: 'COMPLETED' as const, idempotent: false };
}

export async function expireRecoveryRequests(now = new Date()) {
  const expiredApproval = await prisma.vaultRequest.updateMany({ where: { type: 'RECOVERY', status: 'PENDING_APPROVAL', expiresAt: { lte: now } }, data: { status: 'EXPIRED' } });
  const expiredCode = await prisma.vaultRequest.updateMany({ where: { type: 'RECOVERY', status: 'PENDING_CODE', expiresAt: { lte: now } }, data: { status: 'EXPIRED' } });
  const expiredRelease = await prisma.vaultRequest.updateMany({ where: { type: 'RECOVERY', status: 'RELEASED', releaseExpiresAt: { lte: now } }, data: { status: 'EXPIRED', rootShareForClient: null, rootSignature: null } });
  return expiredApproval.count + expiredCode.count + expiredRelease.count;
}
