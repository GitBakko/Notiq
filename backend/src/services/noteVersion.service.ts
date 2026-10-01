import prisma from '../plugins/prisma';
import { Prisma } from '@prisma/client';
import { extractTextFromTipTapJson } from '../utils/extractText';
import { NotFoundError, ConflictError, AppError } from '../utils/errors';
import logger from '../utils/logger';
import { isDegenerateTipTapJson } from '../utils/ydocIntegrity';
import { getVaultGuard, assertVaultContent } from './vault.service';
import { rebaseYdocState, contentToYNodes } from '../utils/ydoc';

// PrismaClient is assignable to TransactionClient, so this accepts both prisma and a tx client.
type Db = Prisma.TransactionClient;

const SNAPSHOT_THROTTLE_MS = 2 * 60 * 1000; // at most one snapshot / 2 min / note
const MAX_VERSIONS = 50;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MIN_SNAPSHOT_LEN = 150; // don't archive empty/near-empty content

const MAX_SNAPSHOTS_PER_WINDOW = 3; // non-forced snapshots per note inside one window (hostile writer alternation)

// [BACKUP] 2026-10-01 — the throttle used to read the latest NoteVersion.createdAt (any writer, and
// archiveRestWriteWhileLive bumps it): a REST archive row silenced the next collab/REST snapshot, losing content.
//   const latest = await db.noteVersion.findFirst({ where: { noteId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
//   if (latest && Date.now() - new Date(latest.createdAt).getTime() < SNAPSHOT_THROTTLE_MS) return;
// ponytail: in-process state (pm2, 1 instance); after a restart at most one extra snapshot. `recent` keeps { at, id }
// and the cap counts only entries whose row still exists (one findMany when at the cap), so a create undone by a
// transaction rollback does not consume it. Concurrent collab + REST racing on the cap can overshoot by at most +1: accepted.
// `restoredVersionByNote` = the version a restore just wrote back: it is compared too, so the next snapshot of that
// same content is not archived as a duplicate of the version it came from. Kept apart from snapState (which is
// evicted by time / by other notes' snapshots) and consumed by the first non-forced snapshot of the note.
type Recent = { at: number; id: string | null };
type SnapState = { writer: string; snapAt: number; versionId: string | null; recent: Recent[] };
const snapState = new Map<string, SnapState>();
const restoredVersionByNote = new Map<string, string>();
export const __resetSnapshotStateForTests = () => { snapState.clear(); restoredVersionByNote.clear(); };

/**
 * Save the PREVIOUS content of a note as a version, BEFORE it gets overwritten.
 * Throttle (in-memory, never reads NoteVersion.createdAt): the SAME writer is skipped for SNAPSHOT_THROTTLE_MS after
 * its last snapshot, but only while that version row still exists; a DIFFERENT writer always snapshots, capped at
 * MAX_SNAPSHOTS_PER_WINDOW per note per window. `writer` is 'collab' | 'rest:<userId>' | 'restore'.
 * `options.force` (restore) bypasses throttle and cap. Identical-to-latest content and content shorter than
 * MIN_SNAPSHOT_LEN are never archived. Accepts a prisma client or a transaction client.
 */
export async function snapshotPreviousVersion(
  db: Db,
  noteId: string,
  previousContent: string | null | undefined,
  previousTitle: string,
  options?: { force?: boolean; writer?: string },
): Promise<void> {
  const writer = options?.writer ?? 'collab';
  const now = Date.now();
  for (const [k, v] of snapState) {
    if (now - v.snapAt >= SNAPSHOT_THROTTLE_MS && v.recent.every((r) => now - r.at >= SNAPSHOT_THROTTLE_MS)) snapState.delete(k);
  }
  const s = snapState.get(noteId);
  let recent = (s?.recent ?? []).filter((r) => now - r.at < SNAPSHOT_THROTTLE_MS);

  if (!previousContent || previousContent.length < MIN_SNAPSHOT_LEN) {
    snapState.set(noteId, { writer, snapAt: 0, versionId: null, recent });
    return;
  }

  if (!options?.force) {
    if (
      s && s.writer === writer && now - s.snapAt < SNAPSHOT_THROTTLE_MS && s.versionId &&
      await db.noteVersion.findUnique({ where: { id: s.versionId }, select: { id: true } })
    ) return;
    if (recent.length >= MAX_SNAPSHOTS_PER_WINDOW) {
      // P4: count only the creates whose row still exists (a rolled-back create must not use up the cap)
      const ids = recent.flatMap((r) => (r.id ? [r.id] : []));
      if (ids.length > 0) {
        const alive = new Set((await db.noteVersion.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((v) => v.id));
        recent = recent.filter((r) => !r.id || alive.has(r.id));
      }
    }
    if (recent.length >= MAX_SNAPSHOTS_PER_WINDOW) {
      // L3: the skipped writer made no snapshot: do not hand it the previous writer's snapAt/versionId
      snapState.set(noteId, { writer, snapAt: 0, versionId: null, recent });
      return;
    }
    // consumed here: first non-forced snapshot of the note that gets past throttle/cap, create or identical-skip
    const restoredId = restoredVersionByNote.get(noteId);
    restoredVersionByNote.delete(noteId);
    const latest = await db.noteVersion.findFirst({
      where: { noteId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, content: true },
    });
    if (latest && latest.content === previousContent) {
      snapState.set(noteId, { writer, snapAt: now, versionId: latest.id, recent });
      return;
    }
    // P3: the content a restore just wrote back is already archived as that version: no duplicate copy of it
    if (restoredId) {
      const restored = await db.noteVersion.findUnique({ where: { id: restoredId }, select: { id: true, content: true } });
      if (restored && restored.content === previousContent) {
        snapState.set(noteId, { writer, snapAt: now, versionId: restored.id, recent });
        return;
      }
    }
  } else {
    // R3: a forced (restore) snapshot of content that is already archived (latest version, or the version a previous
    // restore wrote back) would only add a copy of it.
    const restoredId = restoredVersionByNote.get(noteId);
    const [latest, restored] = await Promise.all([
      db.noteVersion.findFirst({ where: { noteId }, orderBy: { createdAt: 'desc' }, select: { id: true, content: true } }),
      restoredId ? db.noteVersion.findUnique({ where: { id: restoredId }, select: { id: true, content: true } }) : null,
    ]);
    if ((latest && latest.content === previousContent) || (restored && restored.content === previousContent)) return;
  }

  const created = await db.noteVersion.create({
    data: { noteId, content: previousContent, title: previousTitle },
  });
  snapState.set(noteId, { writer, snapAt: now, versionId: created?.id ?? null, recent: options?.force ? recent : [...recent, { at: now, id: created?.id ?? null }] }); // L2: forced snapshots do not use up the cap
  await pruneNoteVersions(db, noteId);
}

// ponytail: in-process map — single backend process (pm2 fork, 1 instance); per-note coalescing window
const restArchive = new Map<string, { versionId: string; at: number }>();
// per (noteId:userId): the ONE archive CREATE allowed inside the window (timestamp + its version id)
const restArchiveByUser = new Map<string, { at: number; versionId: string }>();
const PENDING_VERSION = '';
export const __restArchiveSizeForTests = () => restArchive.size;

/**
 * Keep a REST content write recoverable when it is NOT applied because a live collab doc wins.
 * One CREATE per (note, writer) inside SNAPSHOT_THROTTLE_MS; the same login session coalesces into that version
 * (update) so an offline push burst does not churn the 50-version cap; any other session gets a retryable 503
 * (errors.notes.archiveBusy). No MIN_SNAPSHOT_LEN floor, degenerate (blank) content is skipped.
 */
export async function archiveRestWriteWhileLive(
  noteId: string, content: string, title: string, writerUserId: string, sessionKey?: string,
): Promise<'archived' | 'identical' | 'skipped'> {
  if (!content) return 'skipped';
  try {
    if (isDegenerateTipTapJson(JSON.parse(content))) return 'skipped';
  } catch {
    return 'skipped'; // not TipTap JSON: nothing worth archiving here
  }

  const latest = await prisma.noteVersion.findFirst({
    where: { noteId },
    orderBy: { createdAt: 'desc' },
    select: { content: true },
  });
  if (latest?.content === content) return 'identical';

  // Keyed per writer AND login session (JWT iat/jti): another user's or another device's write must not
  // overwrite this writer's archived text. Without a sessionKey we cannot tell devices apart: never coalesce.
  // Evict expired windows on every call (create AND update branch) so the maps do not grow without bound.
  const now = Date.now();
  for (const [k, v] of restArchive) {
    if (now - v.at >= SNAPSHOT_THROTTLE_MS) restArchive.delete(k);
  }
  for (const [k, v] of restArchiveByUser) {
    if (now - v.at >= SNAPSHOT_THROTTLE_MS) restArchiveByUser.delete(k);
  }

  const key = sessionKey ? `${noteId}:${writerUserId}:${sessionKey}` : undefined;
  const userKey = `${noteId}:${writerUserId}`;
  const bump = async (versionId: string) => {
    const exists = await prisma.noteVersion.findUnique({ where: { id: versionId }, select: { id: true } });
    if (!exists) return false;
    // createdAt bumped only so history shows the latest write first; the snapshot throttle never reads
    // NoteVersion rows (it is in-memory state), so this does not suppress any later snapshot.
    await prisma.noteVersion.update({ where: { id: versionId }, data: { content, title, createdAt: new Date() } });
    return true;
  };

  const prev = key ? restArchive.get(key) : undefined;
  // J2: a create by this same session is still in flight (placeholder): same retryable 503, nothing to bump yet.
  if (prev?.versionId === PENDING_VERSION) throw new AppError(503, 'errors.notes.archiveBusy');
  if (prev) {
    if (await bump(prev.versionId)) return 'archived';
    // The version row is gone (pruned): its slot is free again.
    restArchive.delete(key!);
    if (restArchiveByUser.get(userKey)?.versionId === prev.versionId) restArchiveByUser.delete(userKey);
  }

  // H1: a user mints at most ONE archive version per note per window (token rotation would otherwise let a
  // collaborator flush the owner's history via the 50 cap). A different session (or one without sessionKey) must
  // not overwrite the version of another session either, so it is refused with a RETRYABLE 503: the FE queue
  // backs off and retries (400/403/404/422 are permanent there), and by then the window has expired.
  if (restArchiveByUser.has(userKey)) throw new AppError(503, 'errors.notes.archiveBusy');

  // J2: check and claim must be synchronous (no await between them), otherwise two concurrent calls both pass the
  // check above and both create. Claim the slot with a placeholder now, fill in the id after the create.
  const slot = { at: now, versionId: PENDING_VERSION };
  restArchiveByUser.set(userKey, slot);
  if (key) restArchive.set(key, { ...slot });
  let created: { id: string };
  try {
    created = await prisma.noteVersion.create({ data: { noteId, content, title } });
  } catch (e) {
    restArchiveByUser.delete(userKey);
    if (key) restArchive.delete(key);
    throw e;
  }
  slot.versionId = created.id;
  if (key) restArchive.set(key, { versionId: created.id, at: now });
  await pruneNoteVersions(prisma, noteId);
  return 'archived';
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

/**
 * Read-only lookup used by the restore route BEFORE restoring: the version's content and whether the note is a
 * plain one (not vault/encrypted). Same ownership / version checks as restoreNoteVersion.
 */
export async function getVersionForRestoreCheck(
  userId: string, noteId: string, versionId: string,
): Promise<{ content: string; plain: boolean }> {
  const note = await prisma.note.findFirst({
    where: { id: noteId, userId },
    select: { isEncrypted: true, isVault: true },
  });
  if (!note) throw new NotFoundError('errors.notes.notFound');
  const version = await prisma.noteVersion.findUnique({ where: { id: versionId }, select: { noteId: true, content: true } });
  if (!version || version.noteId !== noteId) throw new NotFoundError('errors.notes.versionNotFound');
  return { content: version.content, plain: !note.isVault && !note.isEncrypted };
}

/** Restore a version: archive current content first, then write the old content back. */
export async function restoreNoteVersion(
  userId: string, noteId: string, versionId: string,
  opts?: { beforeRestore?: () => Promise<void> },
): Promise<{ ok: true; restoredContent: string | null }> {
  let note = await prisma.note.findFirst({
    where: { id: noteId, userId },
    select: { id: true, content: true, title: true, isEncrypted: true, isVault: true, noteType: true, ydocState: true },
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
    // L4: the note now holds flushed collab content: mark the writer as collab (even if we abort below) so a later
    // REST write of any user snapshots it.
    const st = snapState.get(noteId);
    snapState.set(noteId, { writer: 'collab', snapAt: 0, versionId: null, recent: st?.recent ?? [] });
    const fresh = await prisma.note.findFirst({
      where: { id: noteId, userId },
      select: { id: true, content: true, title: true, isEncrypted: true, isVault: true, noteType: true, ydocState: true },
    });
    if (!fresh) throw new NotFoundError('errors.notes.notFound');
    // Vault state flipped since the guard/version checks above: abort, write nothing.
    if (fresh.isVault !== note.isVault || fresh.isEncrypted !== note.isEncrypted) {
      throw new ConflictError('errors.notes.restoreConflict');
    }
    note = fresh;
  }

  // H5: a doc may have gone live after the route's pre-check. A live (or loading) doc only takes content that
  // converts strictly to the editor schema (replaceLiveDocContent would throw AFTER the write and the live doc
  // would re-store the old content): refuse before writing AND before the forced snapshot (a refused restore
  // must not mint a version). Lazy import: hocuspocus imports this module (cycle) and throws at import time
  // without JWT_SECRET.
  if (!note.isEncrypted && !note.isVault) {
    const { hocuspocus } = await import('../hocuspocus');
    const inner = hocuspocus.hocuspocus;
    if (inner.documents.has(noteId) || inner.loadingDocuments.has(noteId)) {
      const nodes = contentToYNodes(version.content);
      if (!nodes || nodes.length === 0) throw new AppError(422, 'errors.notes.restoreUnsupportedLive');
    }
  }

  // Archive what we're about to overwrite so a restore is itself undoable.
  // Force-bypass the throttle: a restore is an explicit destructive action and MUST always
  // preserve the current content, even if a snapshot was taken seconds ago.
  try {
    await snapshotPreviousVersion(prisma, noteId, note.content, note.title, { force: true, writer: 'restore' });
  } catch (snapErr) {
    logger.warn({ snapErr, noteId }, 'restoreNoteVersion: snapshot failed — continuing');
  }

  const searchText = (note.isEncrypted || note.isVault) ? null : extractTextFromTipTapJson(version.content);
  // Conditional write: if the owner moved the note into/out of the vault since the (re-)read, nothing
  // matches and we abort, so plaintext never lands in a vault note (or ciphertext in a plain one).
  const { count } = await prisma.note.updateMany({
    where: { id: noteId, userId, isVault: note.isVault, isEncrypted: note.isEncrypted },
    // [BACKUP] 2026-10-01 — was `ydocState: null` (next fetch rebuilt the Yjs doc from content, so a stale client
    // duplicated every block on reconnect). Plain notes now rebase the stored state onto the restored content
    // (null when in doubt); vault/encrypted keep null.
    data: {
      content: version.content,
      title: guard ? '' : version.title,
      searchText,
      // CREDENTIAL notes are not TipTap JSON either: never rebased.
      ydocState: (note.isEncrypted || note.isVault || note.noteType === 'CREDENTIAL') ? null : rebaseYdocState(note.ydocState, version.content),
      updatedAt: new Date(),
    },
  });
  if (count === 0) throw new ConflictError('errors.notes.restoreConflict');
  // P3: remember which version now IS the note content (see snapshotPreviousVersion).
  restoredVersionByNote.set(noteId, versionId);
  // G7: the restore replaced the content, so pending REST-archive coalescing windows of this note are stale.
  for (const k of restArchive.keys()) {
    if (k.startsWith(`${noteId}:`)) restArchive.delete(k);
  }
  for (const k of restArchiveByUser.keys()) {
    if (k.startsWith(`${noteId}:`)) restArchiveByUser.delete(k);
  }
  // onAuthenticate refuses only isVault docs (never live); encrypted notes (isEncrypted, set only by vault
  // flows) are skipped because their content is ciphertext, not TipTap JSON.
  return { ok: true, restoredContent: (note.isEncrypted || note.isVault) ? null : version.content };
}
