import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import prisma from '../plugins/prisma';
import { AppError, ConflictError, isPrismaError } from '../utils/errors';
import { VAULT_ROOT_KEYS } from '../utils/vaultRootKeys';
import { logEvent } from './audit.service';
import { sendNotificationEmail } from './email.service';
import logger from '../utils/logger';

// Pepper: letto a ogni chiamata, nessuna cache (i test cambiano process.env).
function readPepper(): Buffer | 'missing' | 'invalid' {
  const v = process.env.VAULT_PEPPER_KEY;
  if (!v) return 'missing';
  if (!/^[A-Za-z0-9_-]{43}$/.test(v)) return 'invalid';
  const buf = Buffer.from(v, 'base64url');
  return buf.length === 32 ? buf : 'invalid';
}

function derive(pepper: Buffer, info: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', pepper, '', info, 32));
}

function deriveOrThrow(info: string): Buffer {
  const pepper = readPepper();
  if (typeof pepper === 'string') throw new AppError(503, 'errors.vault.unavailable');
  return derive(pepper, info);
}

export function pepperStatus(): { status: 'ok' | 'missing' | 'invalid'; keyId?: string } {
  const pepper = readPepper();
  if (typeof pepper === 'string') return { status: pepper };
  return { status: 'ok', keyId: derive(pepper, 'notiq/vault/v3/pepper-id').subarray(0, 8).toString('hex') };
}

export function verifierKey(): Buffer {
  return deriveOrThrow('notiq/vault/v3/verifier');
}

export function shareWrapKey(): Buffer {
  return deriveOrThrow('notiq/vault/v3/sharewrap');
}

export function sha256hex(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

const ENVELOPE_RE = /^nv3\.(0|[1-9]\d{0,8})\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$/;

export function parseEnvelope(s: unknown): { epoch: number } | null {
  if (typeof s !== 'string') return null;
  const m = ENVELOPE_RE.exec(s);
  return m ? { epoch: Number(m[1]) } : null;
}

export type VaultGuard = { epoch: number; ready: boolean };

export async function getVaultGuard(
  userId: string,
  db: Pick<Prisma.TransactionClient, 'vaultKeyring'> = prisma,
): Promise<VaultGuard | null> {
  if (!userId) throw new Error('getVaultGuard: userId required');
  const row = await db.vaultKeyring.findUnique({ where: { userId }, select: { status: true, epoch: true } });
  if (!row) return null;
  if (row.status === 'NONE' && row.epoch === 0) return null;
  return { epoch: row.epoch, ready: row.status === 'READY' };
}

export function assertVaultContent(
  content: unknown,
  guard: VaultGuard,
  baseHash?: string,
  current?: string,
): void {
  if (!guard.ready) throw new AppError(422, 'errors.vault.notReady');
  const env = parseEnvelope(content);
  if (!env) throw new AppError(422, 'errors.vault.plaintextRejected');
  if (env.epoch !== guard.epoch) throw new AppError(422, 'errors.vault.stale');
  if (current !== undefined && (!baseHash || baseHash !== sha256hex(current))) {
    throw new AppError(422, 'errors.vault.conflict');
  }
}

export function verifyVkProof(
  row: { userId: string; epoch: number; vkSigPub: Uint8Array | null },
  method: string,
  path: string,
  payloadRaw: string,
  rev: number,
  sig: Buffer,
): void {
  const msg = `notiq/vault/v3/proof|${method} ${path}|${row.userId}|${row.epoch}|${rev}|${sha256hex(payloadRaw)}`;
  let ok = false;
  try {
    if (row.vkSigPub) {
      ok = crypto.verify(
        'sha256',
        Buffer.from(msg, 'utf8'),
        { key: Buffer.from(row.vkSigPub), format: 'der', type: 'spki', dsaEncoding: 'ieee-p1363' },
        sig,
      );
    }
  } catch {
    ok = false;
  }
  if (!ok) throw new AppError(403, 'errors.vault.invalidProof');
}

// ---------------------------------------------------------------- Keyring (T6)

export function b64url(len: number | [number, number]) {
  const [min, max] = typeof len === 'number' ? [len, len] : len;
  return z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/, 'invalid')
    .refine((v) => {
      const n = Buffer.from(v, 'base64url').length;
      return n >= min && n <= max;
    }, 'invalid');
}

const shareAad = (userId: string, epoch: number) =>
  Buffer.from(`notiq/vault/v3/servershare|${userId}|${epoch}`, 'utf8');

function sealServerShare(userId: string, epoch: number, share: Uint8Array): Buffer<ArrayBuffer> {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', shareWrapKey(), iv);
  c.setAAD(shareAad(userId, epoch));
  const ct = Buffer.concat([c.update(share), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]);
}

export function openServerShare(userId: string, epoch: number, enc: Buffer): Buffer {
  const d = crypto.createDecipheriv('aes-256-gcm', shareWrapKey(), enc.subarray(0, 12));
  d.setAAD(shareAad(userId, epoch));
  d.setAuthTag(enc.subarray(enc.length - 16));
  return Buffer.concat([d.update(enc.subarray(12, enc.length - 16)), d.final()]);
}

function authVerifierOf(userId: string, authKey: Uint8Array): Buffer<ArrayBuffer> {
  return Buffer.from(
    crypto.createHmac('sha256', verifierKey()).update(userId, 'utf8').update('|', 'utf8').update(authKey).digest(),
  );
}

export async function countLegacyVaultNotes(
  userId: string,
  db: Pick<Prisma.TransactionClient, 'note'> = prisma,
): Promise<number> {
  return db.note.count({ where: { userId, isVault: true, NOT: { content: { startsWith: 'nv3.' } } } });
}

const toB64 = (v: Uint8Array | null | undefined) => (v ? Buffer.from(v).toString('base64url') : null);

export async function getKeyring(userId: string) {
  if (!userId) throw new Error('getKeyring: userId required');
  const row = await prisma.vaultKeyring.findUnique({
    where: { userId },
    select: {
      status: true, epoch: true, rev: true, kdf: true, kdfParams: true, pinSalt: true,
      wrappedVkPin: true, wrappedVkSigKey: true, rootKeyId: true, migrationState: true,
      lockedUntil: true, resetScheduledAt: true,
    },
  });
  const legacyCount = await countLegacyVaultNotes(userId);
  if (!row) {
    return {
      status: 'NONE', epoch: 0, rev: 0, kdf: null, kdfParams: null, pinSalt: null, wrappedVkPin: null,
      wrappedVkSigKey: null, rootKeyId: null, migrationState: 'NONE', lockedUntil: null,
      resetScheduledAt: null, legacyCount,
    };
  }
  return {
    ...row,
    pinSalt: toB64(row.pinSalt),
    wrappedVkPin: toB64(row.wrappedVkPin),
    wrappedVkSigKey: toB64(row.wrappedVkSigKey),
    legacyCount,
  };
}

type Bytes = Buffer<ArrayBuffer>;

// ES2022 Object.hasOwn non e' nella lib di questo tsconfig
const isRootKey = (id: string) => Object.prototype.hasOwnProperty.call(VAULT_ROOT_KEYS, id);

export interface CreateKeyringDto {
  expectedEpoch: number;
  password: string;
  kdf: 'argon2id';
  kdfParams: { m: number; t: number; p: number };
  pinSalt: Bytes;
  wrappedVkPin: Bytes;
  authKey: Bytes;
  serverShare: Bytes;
  vkSigPub: Bytes;
  wrappedVkSigKey: Bytes;
  escrowBlob: Bytes;
  sealedRootShare: Bytes;
  rootKeyId: string;
  userShareUnderVk: Bytes;
}

export async function createKeyring(userId: string, dto: CreateKeyringDto) {
  // RT-1: prima di qualsiasi lettura
  if (Object.keys(VAULT_ROOT_KEYS).length === 0) throw new AppError(503, 'errors.vault.unavailable');
  if (!isRootKey(dto.rootKeyId)) throw new AppError(400, 'errors.vault.invalidRootKey');

  // D2: password dell'account obbligatoria
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { password: true } });
  if (!user || !(await bcrypt.compare(dto.password, user.password))) {
    await logEvent(userId, 'vault.keyring.passwordRejected');
    throw new AppError(403, 'errors.vault.invalidPassword');
  }

  const epoch = dto.expectedEpoch;
  const pepperKeyId = pepperStatus().keyId;
  const authVerifier = authVerifierOf(userId, dto.authKey);
  const serverShareEnc = sealServerShare(userId, epoch, dto.serverShare);
  const migrationState = (await countLegacyVaultNotes(userId)) > 0 ? 'IN_PROGRESS' : 'NONE';

  // Solo valori derivati/cifrati: mai authKey, serverShare o password in chiaro verso Prisma.
  const fields = {
    kdf: dto.kdf,
    kdfParams: dto.kdfParams,
    pinSalt: dto.pinSalt,
    wrappedVkPin: dto.wrappedVkPin,
    authVerifier,
    serverShareEnc,
    pepperKeyId,
    vkSigPub: dto.vkSigPub,
    wrappedVkSigKey: dto.wrappedVkSigKey,
    escrowBlob: dto.escrowBlob,
    sealedRootShare: dto.sealedRootShare,
    rootKeyId: dto.rootKeyId,
    userShareUnderVk: dto.userShareUnderVk,
    migrationState,
  } as const;

  let rev = 0;
  let created = false;
  if (epoch === 0) {
    try {
      const row = await prisma.vaultKeyring.create({ data: { userId, epoch: 0, status: 'READY', ...fields } });
      rev = row?.rev ?? 0;
      created = true;
    } catch (e) {
      if (!isPrismaError(e, 'P2002')) throw e;
    }
  }
  if (!created) {
    // RT-10: riga NONE gia' esistente (o epoch > 0 dopo un reset)
    const r = await prisma.vaultKeyring.updateMany({
      where: { userId, status: 'NONE', epoch },
      data: {
        ...fields,
        status: 'READY',
        failedAttempts: 0,
        lockedUntil: null,
        resetScheduledAt: null,
        rev: { increment: 1 },
      },
    });
    if (r.count !== 1) throw new ConflictError('errors.vault.alreadySetup');
    const cur = await prisma.vaultKeyring.findUnique({ where: { userId }, select: { rev: true } });
    rev = cur?.rev ?? 1;
  }

  await logEvent(userId, 'vault.keyring.created', { epoch, migrationState });
  return { status: 'READY' as const, epoch, rev };
}

export const keyringUpdatePayloadSchema = z.object({
  rev: z.number().int().min(0).max(2147483646),
  wrap: z
    .object({
      kdf: z.literal('argon2id'),
      kdfParams: z.object({
        m: z.number().int().min(65536).max(1048576),
        t: z.number().int().min(3).max(10),
        p: z.literal(1),
      }),
      pinSalt: b64url(16),
      wrappedVkPin: b64url(60),
      authKey: b64url(32),
    })
    .optional(),
  escrow: z
    .object({
      escrowBlob: b64url(60),
      sealedRootShare: b64url(157),
      rootKeyId: z.string().min(1).max(64),
      userShareUnderVk: b64url(48),
    })
    .optional(),
  rotate: z.unknown().optional(),
});

export async function updateKeyring(userId: string, payloadRaw: string, proof: Buffer) {
  let payload: z.infer<typeof keyringUpdatePayloadSchema>;
  try {
    const parsed = keyringUpdatePayloadSchema.safeParse(JSON.parse(payloadRaw));
    if (!parsed.success) throw new Error('invalid');
    payload = parsed.data;
  } catch {
    throw new AppError(400, 'errors.vault.invalidPayload');
  }

  const row = await prisma.vaultKeyring.findUnique({ where: { userId } });
  if (!row || row.status !== 'READY') throw new AppError(409, 'errors.vault.notReady');

  verifyVkProof(row, 'PUT', '/api/vault/keyring', payloadRaw, payload.rev, proof);

  if (payload.rotate !== undefined) throw new AppError(400, 'errors.vault.rotateNotSupported');
  const { wrap, escrow } = payload;
  if (escrow && !isRootKey(escrow.rootKeyId)) {
    throw new AppError(400, 'errors.vault.invalidRootKey');
  }
  if (wrap && row.pepperKeyId !== pepperStatus().keyId) {
    throw new AppError(503, 'errors.vault.pepperMismatch');
  }

  const dec = (v: string) => Buffer.from(v, 'base64url');
  const data: Prisma.VaultKeyringUpdateManyMutationInput = { rev: { increment: 1 } };
  if (wrap) {
    data.kdf = wrap.kdf;
    data.kdfParams = wrap.kdfParams;
    data.pinSalt = dec(wrap.pinSalt);
    data.wrappedVkPin = dec(wrap.wrappedVkPin);
    data.authVerifier = authVerifierOf(userId, dec(wrap.authKey));
    data.pepperKeyId = pepperStatus().keyId;
  }
  if (escrow) {
    data.escrowBlob = dec(escrow.escrowBlob);
    data.sealedRootShare = dec(escrow.sealedRootShare);
    data.rootKeyId = escrow.rootKeyId;
    data.userShareUnderVk = dec(escrow.userShareUnderVk);
  }

  const r = await prisma.vaultKeyring.updateMany({
    where: { userId, status: 'READY', epoch: row.epoch, rev: payload.rev },
    data,
  });
  if (r.count === 0) throw new AppError(409, 'errors.vault.staleRev');

  await logEvent(userId, 'vault.keyring.updated', { wrap: !!wrap, escrow: !!escrow });
  return { rev: payload.rev + 1 };
}

// ---------------------------------------------------------------- Unlock (T7)

export async function unlock(userId: string, authKey: Buffer): Promise<{ serverShare: Buffer }> {
  if (!userId) throw new Error('unlock: userId required');
  const ps = pepperStatus();
  if (ps.status !== 'ok') throw new AppError(503, 'errors.vault.unavailable');

  const row = await prisma.vaultKeyring.findUnique({
    where: { userId },
    select: { status: true, epoch: true, authVerifier: true, serverShareEnc: true, pepperKeyId: true },
  });
  if (!row || row.status !== 'READY') throw new AppError(409, 'errors.vault.notReady');
  // Pepper sostituito: non e' un tentativo, nessun incremento
  if (row.pepperKeyId !== ps.keyId) throw new AppError(503, 'errors.vault.pepperMismatch');

  const expected = authVerifierOf(userId, authKey);
  const stored = row.authVerifier ? Buffer.from(row.authVerifier) : null;
  const ok = !!stored && stored.length === expected.length && crypto.timingSafeEqual(stored, expected);

  if (!ok) {
    // Un solo statement atomico (RT-3), tempo in UTC: le colonne TIMESTAMP(3) di Prisma sono UTC
    const rows = await prisma.$queryRaw<{ failedAttempts: number; lockedUntil: Date | null }[]>`
      UPDATE "VaultKeyring"
      SET "failedAttempts" = "failedAttempts" + 1,
          "lockedUntil" = CASE WHEN ("failedAttempts" + 1) % 6 = 0
            THEN (now() AT TIME ZONE 'UTC') + CASE LEAST(("failedAttempts" + 1) / 6, 3)
                 WHEN 1 THEN interval '15 minutes' WHEN 2 THEN interval '1 hour' ELSE interval '24 hours' END
            ELSE "lockedUntil" END,
          "updatedAt" = now() AT TIME ZONE 'UTC'
      WHERE "userId" = ${userId} AND "status" = 'READY'
        AND ("lockedUntil" IS NULL OR "lockedUntil" <= now() AT TIME ZONE 'UTC')
      RETURNING "failedAttempts", "lockedUntil"`;
    if (rows.length === 0) throw new AppError(429, 'errors.vault.locked');

    const { failedAttempts: n, lockedUntil } = rows[0];
    if (n % 6 === 0) {
      const until = lockedUntil?.toISOString();
      await logEvent(userId, 'vault.unlock.locked', { n, lockedUntil: until });
      // fire-and-forget: nessun errore (DB o SMTP) cambia la risposta 403
      void prisma.user
        .findUnique({ where: { id: userId }, select: { email: true, locale: true } })
        .then((user) =>
          user
            ? sendNotificationEmail(user.email, 'VAULT_LOCKOUT', {
                locale: user.locale || 'en',
                lockedUntil: until ?? '',
                attempts: String(n),
              })
            : undefined,
        )
        .catch((err) => logger.warn({ err }, 'vault lockout email failed'));
    }
    throw new AppError(403, 'errors.vault.invalidPin');
  }

  const r = await prisma.vaultKeyring.updateMany({
    where: {
      userId,
      status: 'READY',
      epoch: row.epoch,
      OR: [{ lockedUntil: null }, { lockedUntil: { lte: new Date() } }],
    },
    data: { failedAttempts: 0, lockedUntil: null },
  });
  if (r.count !== 1) throw new AppError(429, 'errors.vault.locked');

  // serverShareEnc null o GCM fallito: stato corrotto, l'errore si propaga (500)
  return { serverShare: openServerShare(userId, row.epoch, Buffer.from(row.serverShareEnc!)) };
}

// ---------------------------------------------------------------- Items, migrate, finalize (T8)

const itemSelect = { id: true, noteType: true, content: true, updatedAt: true, isTrashed: true } as const;

export async function getItems(userId: string, opts: { ids?: string[]; after?: string } = {}) {
  if (!userId) throw new Error('getItems: userId required');
  const toItem = (r: { id: string; noteType: string; content: string; updatedAt: Date; isTrashed: boolean }) => ({
    id: r.id,
    noteType: r.noteType,
    content: r.content,
    contentHash: sha256hex(r.content),
    updatedAt: r.updatedAt,
    isTrashed: r.isTrashed,
  });

  if (opts.ids) {
    const rows = await prisma.note.findMany({
      where: { userId, isVault: true, id: { in: opts.ids } },
      select: itemSelect,
    });
    return { items: rows.map(toItem), next: null as string | null };
  }

  const rows = await prisma.note.findMany({
    where: { userId, isVault: true, ...(opts.after ? { id: { gt: opts.after } } : {}) },
    orderBy: { id: 'asc' },
    take: 101,
    select: itemSelect,
  });
  const page = rows.slice(0, 100);
  return { items: page.map(toItem), next: rows.length > 100 ? page[99].id : null };
}

export type MigrateStatus = 'ok' | 'already' | 'conflict' | 'notFound' | 'invalid';

class MigrateConflict extends Error {}

export async function migrateItems(
  userId: string,
  items: { id: string; baseHash: string; content: string; noteType: string }[],
) {
  if (!userId) throw new Error('migrateItems: userId required');
  const guard = await getVaultGuard(userId);
  if (!guard?.ready) throw new AppError(409, 'errors.vault.notReady');

  const results: { id: string; status: MigrateStatus }[] = [];
  for (const item of items) {
    let status: MigrateStatus;
    try {
      status = await prisma.$transaction(async (tx): Promise<MigrateStatus> => {
        const current = await tx.note.findFirst({
          where: { id: item.id, userId, isVault: true },
          select: { content: true, title: true, noteType: true },
        });
        if (!current) return 'notFound';
        if (parseEnvelope(current.content)?.epoch === guard.epoch) return 'already';
        const env = parseEnvelope(item.content);
        if (item.noteType !== current.noteType || !env || env.epoch !== guard.epoch) return 'invalid';
        if (sha256hex(current.content) !== item.baseHash) return 'conflict';

        await tx.noteVersion.create({ data: { noteId: item.id, content: current.content, title: current.title } });
        const r = await tx.note.updateMany({
          where: { id: item.id, userId, isVault: true, content: current.content },
          data: { content: item.content, title: '', isEncrypted: true, searchText: null, ydocState: null },
        });
        // sentinella: fa andare in rollback lo snapshot
        if (r.count === 0) throw new MigrateConflict();
        return 'ok';
      });
    } catch (e) {
      if (!(e instanceof MigrateConflict)) throw e;
      status = 'conflict';
    }
    results.push({ id: item.id, status });
  }

  const count = (s: MigrateStatus) => results.filter((r) => r.status === s).length;
  await logEvent(userId, 'vault.migrate', {
    ok: count('ok'),
    already: count('already'),
    conflict: count('conflict'),
    notFound: count('notFound'),
    invalid: count('invalid'),
  });
  return { results };
}

export async function finalize(userId: string, ids: string[]) {
  if (!userId) throw new Error('finalize: userId required');
  const guard = await getVaultGuard(userId);
  if (!guard?.ready) throw new AppError(409, 'errors.vault.notReady');

  const rows = await prisma.note.findMany({
    where: { userId, isVault: true, id: { in: ids } },
    select: { id: true, content: true },
  });
  const accepted = rows.filter((r) => parseEnvelope(r.content)?.epoch === guard.epoch).map((r) => r.id);
  const acceptedSet = new Set(accepted);
  const rejected = [...new Set(ids)].filter((id) => !acceptedSet.has(id));

  if (accepted.length > 0) {
    await prisma.noteVersion.deleteMany({
      where: { noteId: { in: accepted }, NOT: { content: { startsWith: 'nv3.' } } },
    });
  }

  const legacyCount = await countLegacyVaultNotes(userId);
  const ring = await prisma.vaultKeyring.findUnique({ where: { userId }, select: { migrationState: true } });
  let migrationState = ring?.migrationState ?? 'NONE';
  if (legacyCount === 0 && migrationState === 'IN_PROGRESS') {
    await prisma.vaultKeyring.updateMany({
      where: { userId, migrationState: 'IN_PROGRESS' },
      data: { migrationState: 'DONE' },
    });
    migrationState = 'DONE';
  }

  await logEvent(userId, 'vault.finalize', { finalized: accepted.length, rejected: rejected.length, legacyCount });
  return { finalized: accepted.length, rejected, legacyCount, migrationState };
}
