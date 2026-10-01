import prisma from '../plugins/prisma';
import { Prisma } from '@prisma/client';
import { extractTextFromTipTapJson } from '../utils/extractText';
import { NotFoundError, ConflictError } from '../utils/errors';
import logger from '../utils/logger';
import { isDegenerateTipTapJson } from '../utils/ydocIntegrity';
import { getVaultGuard, assertVaultContent } from './vault.service';

// PrismaClient is assignable to TransactionClient, so this accepts both prisma and a tx client.
type Db = Prisma.TransactionClient;

const SNAPSHOT_THROTTLE_MS = 2 * 60 * 1000; // at most one snapshot / 2 min / note
const MAX_VERSIONS = 50;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MIN_SNAPSHOT_LEN = 150; // don't archive empty/near-empty content

/**
 * Save the PREVIOUS content of a note as a version, BEFORE it gets overwritten.
 * Throttled per-note (max one snapshot per SNAPSHOT_THROTTLE_MS) unless `options.force`
 * is true — force bypasses the throttle so explicit destructive actions (e.g. restore)
 * always preserve the current content. The MIN_SNAPSHOT_LEN guard is never bypassed.
 * Accepts a prisma client or a transaction client.
 */
export async function snapshotPreviousVersion(
  db: Db,
  noteId: string,
  previousContent: string | null | undefined,
  previousTitle: string,
  options?: { force?: boolean },
): Promise<void> {
  if (!previousContent || previousContent.length < MIN_SNAPSHOT_LEN) return;

  if (!options?.force) {
    const latest = await db.noteVersion.findFirst({
      where: { noteId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (latest && Date.now() - new Date(latest.createdAt).getTime() < SNAPSHOT_THROTTLE_MS) {
      return;
    }
  }

  await db.noteVersion.create({
    data: { noteId, content: previousContent, title: previousTitle },
  });
  await pruneNoteVersions(db, noteId);
}

// ponytail: in-process map — single backend process (pm2 fork, 1 instance); per-note coalescing window
const restArchive = new Map<string, { versionId: string; at: number }>();

/**
 * Keep a REST content write recoverable when it is NOT applied because a live collab doc wins.
 * Coalesced per note inside SNAPSHOT_THROTTLE_MS (updates the same version) so an offline push burst
 * does not churn the 50-version cap. No MIN_SNAPSHOT_LEN floor, degenerate (blank) content is skipped.
 */
export async function archiveRestWriteWhileLive(noteId: string, content: string, title: string): Promise<void> {
  if (!content) return;
  try {
    if (isDegenerateTipTapJson(JSON.parse(content))) return;
  } catch {
    return; // not TipTap JSON: nothing worth archiving here
  }

  const latest = await prisma.noteVersion.findFirst({
    where: { noteId },
    orderBy: { createdAt: 'desc' },
    select: { content: true },
  });
  if (latest?.content === content) return;

  const prev = restArchive.get(noteId);
  if (prev && Date.now() - prev.at < SNAPSHOT_THROTTLE_MS) {
    const exists = await prisma.noteVersion.findUnique({ where: { id: prev.versionId }, select: { id: true } });
    if (exists) {
      await prisma.noteVersion.update({ where: { id: prev.versionId }, data: { content, title } });
      return;
    }
  }

  const created = await prisma.noteVersion.create({ data: { noteId, content, title } });
  await pruneNoteVersions(prisma, noteId);
  restArchive.set(noteId, { versionId: created.id, at: Date.now() });
}

/** Retention: drop versions older than 30 days, then any beyond the newest 50. */
export async function pruneNoteVersions(db: Db, noteId: string): Promise<void> {
  await db.noteVersion.deleteMany({
    where: { noteId, createdAt: { lt: new Date(Date.now() - MAX_AGE_MS) } },
  });

  const keepNewest = await db.noteVersion.findMany({
    where: { noteId },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
    skip: MAX_VERSIONS,
  });
  if (keepNewest.length > 0) {
    await db.noteVersion.deleteMany({ where: { id: { in: keepNewest.map((v) => v.id) } } });
  }
}

export interface NoteVersionSummary {
  id: string;
  title: string;
  content: string;
  createdAt: Date;
}

/** List versions of a note the user OWNS. Returns metadata + content for preview, newest first. */
export async function listNoteVersions(userId: string, noteId: string): Promise<NoteVersionSummary[]> {
  const note = await prisma.note.findFirst({ where: { id: noteId, userId } });
  if (!note) throw new NotFoundError('errors.notes.notFound');

  return prisma.noteVersion.findMany({
    where: { noteId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, title: true, content: true, createdAt: true },
  });
}

/** Restore a version: archive current content first, then write the old content back. */
export async function restoreNoteVersion(
  userId: string, noteId: string, versionId: string,
  opts?: { beforeRestore?: () => Promise<void> },
): Promise<{ ok: true; restoredContent: string | null }> {
  let note = await prisma.note.findFirst({
    where: { id: noteId, userId },
    select: { id: true, content: true, title: true, isEncrypted: true, isVault: true },
  });
  if (!note) throw new NotFoundError('errors.notes.notFound');

  const version = await prisma.noteVersion.findUnique({ where: { id: versionId } });
  if (!version || version.noteId !== noteId) throw new NotFoundError('errors.notes.versionNotFound');

  const guard = note.isVault ? await getVaultGuard(userId) : null;
  if (guard) assertVaultContent(version.content, guard);

  // Hook runs only after every check passed (e.g. flush live collab edits to the DB). It may change
  // note.content, so re-read it: the forced snapshot below must archive the flushed content.
  if (opts?.beforeRestore) {
    await opts.beforeRestore();
    const fresh = await prisma.note.findFirst({
      where: { id: noteId, userId },
      select: { id: true, content: true, title: true, isEncrypted: true, isVault: true },
    });
    if (!fresh) throw new NotFoundError('errors.notes.notFound');
    // Vault state flipped since the guard/version checks above: abort, write nothing.
    if (fresh.isVault !== note.isVault || fresh.isEncrypted !== note.isEncrypted) {
      throw new ConflictError('errors.notes.restoreConflict');
    }
    note = fresh;
  }

  // Archive what we're about to overwrite so a restore is itself undoable.
  // Force-bypass the throttle: a restore is an explicit destructive action and MUST always
  // preserve the current content, even if a snapshot was taken seconds ago.
  try {
    await snapshotPreviousVersion(prisma, noteId, note.content, note.title, { force: true });
  } catch (snapErr) {
    logger.warn({ snapErr, noteId }, 'restoreNoteVersion: snapshot failed — continuing');
  }

  const searchText = (note.isEncrypted || note.isVault) ? null : extractTextFromTipTapJson(version.content);
  // Conditional write: if the owner moved the note into/out of the vault since the (re-)read, nothing
  // matches and we abort, so plaintext never lands in a vault note (or ciphertext in a plain one).
  const { count } = await prisma.note.updateMany({
    where: { id: noteId, userId, isVault: note.isVault, isEncrypted: note.isEncrypted },
    // Null ydocState so the next Hocuspocus fetch rebuilds the Yjs doc from restored content.
    data: { content: version.content, title: guard ? '' : version.title, searchText, ydocState: null, updatedAt: new Date() },
  });
  if (count === 0) throw new ConflictError('errors.notes.restoreConflict');
  // onAuthenticate refuses only isVault docs (never live); encrypted notes (isEncrypted, set only by vault
  // flows) are skipped because their content is ciphertext, not TipTap JSON.
  return { ok: true, restoredContent: (note.isEncrypted || note.isVault) ? null : version.content };
}
