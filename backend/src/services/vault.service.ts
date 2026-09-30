import crypto from 'crypto';
import type { Prisma } from '@prisma/client';
import prisma from '../plugins/prisma';
import { AppError } from '../utils/errors';

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
