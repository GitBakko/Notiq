import prisma from '../plugins/prisma';
import { Prisma } from '@prisma/client';

// PrismaClient is assignable to TransactionClient, so this accepts both prisma and a tx client.
type Db = Prisma.TransactionClient;

const SNAPSHOT_THROTTLE_MS = 2 * 60 * 1000; // at most one snapshot / 2 min / note
const MAX_VERSIONS = 50;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MIN_SNAPSHOT_LEN = 150; // don't archive empty/near-empty content

/**
 * Save the PREVIOUS content of a note as a version, BEFORE it gets overwritten.
 * Throttled per-note. Accepts a prisma client or a transaction client.
 */
export async function snapshotPreviousVersion(
  db: Db,
  noteId: string,
  previousContent: string | null | undefined,
  previousTitle: string,
): Promise<void> {
  if (!previousContent || previousContent.length < MIN_SNAPSHOT_LEN) return;

  const latest = await db.noteVersion.findFirst({
    where: { noteId },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  if (latest && Date.now() - new Date(latest.createdAt).getTime() < SNAPSHOT_THROTTLE_MS) {
    return;
  }

  await db.noteVersion.create({
    data: { noteId, content: previousContent, title: previousTitle },
  });
  await pruneNoteVersions(db, noteId);
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
