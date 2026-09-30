import prisma from '../plugins/prisma';
import { hocuspocus, extensions } from '../hocuspocus';
import { TiptapTransformer } from '@hocuspocus/transformer';
import * as Y from 'yjs';
import { v4 as uuidv4 } from 'uuid';
import { extractTextFromTipTapJson, countDocumentStats } from '../utils/extractText';
import { NotFoundError, BadRequestError, ConflictError, AppError } from '../utils/errors';
import { guardEmptyContentOverwrite } from '../utils/contentGuard';
import { logEvent } from './audit.service';
import { snapshotPreviousVersion } from './noteVersion.service';
import { getVaultGuard, assertVaultContent, parseEnvelope, sha256hex } from './vault.service';
import logger from '../utils/logger';

export const checkNoteAccess = async (userId: string, noteId: string): Promise<'OWNER' | 'READ' | 'WRITE' | null> => {
  const note = await prisma.note.findUnique({
    where: { id: noteId },
    select: {
      userId: true,
      isVault: true,
      sharedWith: { where: { userId, status: 'ACCEPTED' }, select: { permission: true } }
    }
  });
  if (!note) return null;
  if (note.userId === userId) return 'OWNER';
  if (note.isVault) return null; // vault notes are never accessible to non-owners
  if (note.sharedWith.length > 0) return note.sharedWith[0].permission as 'READ' | 'WRITE';
  return null;
};

export const createNote = async (
  userId: string,
  title: string,
  content: string,
  notebookId: string,
  isVault: boolean = false,
  isEncrypted: boolean = false,
  id?: string,
  noteType: 'NOTE' | 'CREDENTIAL' = 'NOTE'
) => {
  // Check if notebook exists/belongs to user
  let targetNotebookId = notebookId;
  const notebook = await prisma.notebook.findFirst({
    where: { id: notebookId, userId },
  });

  if (!notebook) {
    // Fallback: find ANY notebook for this user
    const anyNotebook = await prisma.notebook.findFirst({
      where: { userId },
    });
    if (anyNotebook) {
      targetNotebookId = anyNotebook.id;
    } else {
      // Create a default notebook? For now throw
      throw new NotFoundError('errors.notebooks.notFound');
    }
  }

  // Vault P1: with a keyring the server only accepts envelopes (no CAS on create).
  if (isVault) {
    const guard = await getVaultGuard(userId);
    if (guard) {
      assertVaultContent(content, guard);
      if (title !== '') throw new AppError(422, 'errors.vault.plaintextRejected');
      isEncrypted = true;
    }
  }

  try {
    const searchText = (isEncrypted || noteType === 'CREDENTIAL') ? null : extractTextFromTipTapJson(content);
    return await prisma.note.create({
      data: {
        ...(id ? { id } : {}),
        title,
        content,
        searchText,
        userId,
        notebookId: targetNotebookId,
        isVault,
        isEncrypted,
        noteType,
      },
    });
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as { code: string }).code === 'P2002') {
      // Idempotency only for the caller's OWN note; a foreign id must not leak (IDOR, RT-9)
      // Prisma drops undefined where-values: without id the lookup would match any note of the caller
      if (id) {
        const existing = await prisma.note.findFirst({ where: { id, userId } });
        if (existing) return existing;
      }
      throw new ConflictError('errors.notes.idConflict');
    }
    throw error;
  }
};

export const getNotes = async (userId: string, notebookId?: string, search?: string, tagId?: string, reminderFilter?: 'all' | 'pending' | 'done', includeTrashed: boolean = false, page: number = 1, limit: number = 50) => {
  const whereClause = {
    userId,
    ...(notebookId ? { notebookId } : {}),
    ...(tagId ? { tags: { some: { tagId } } } : {}),
    ...(search ? {
      OR: [
        { title: { contains: search, mode: 'insensitive' as const } },
        { searchText: { contains: search, mode: 'insensitive' as const } },
      ]
    } : {}),
    ...(reminderFilter ? {
      reminderDate: { not: null },
      ...(reminderFilter === 'pending' ? { isReminderDone: false } : {}),
      ...(reminderFilter === 'done' ? { isReminderDone: true } : {}),
    } : {}),
    ...(includeTrashed ? {} : { isTrashed: false }),
  };

  const notes = await prisma.note.findMany({
    where: whereClause,
    orderBy: { updatedAt: 'desc' },
    skip: (page - 1) * limit,
    take: limit,
    select: {
      id: true,
      title: true,
      notebookId: true,
      userId: true,
      isPinned: true,
      isTrashed: true,
      isEncrypted: true,
      isPublic: true,
      isVault: true,
      noteType: true,
      shareId: true,
      reminderDate: true,
      isReminderDone: true,
      createdAt: true,
      updatedAt: true,
      searchText: true,
      tags: { where: { userId }, include: { tag: true } },
      attachments: {
        where: { isLatest: true },
        select: { id: true, filename: true, mimeType: true, size: true }
      },
      sharedWith: {
        include: {
          user: {
            select: { id: true, name: true, email: true, avatarUrl: true }
          }
        }
      },
      user: {
        select: { id: true, name: true, email: true, avatarUrl: true }
      },
      _count: { select: { attachments: true } }
    }
  });

  return notes;
};

export const getNote = async (userId: string, id: string) => {
  return prisma.note.findFirst({
    where: {
      id,
      OR: [
        { userId },
        // [BACKUP] 2026-09-02 — was `{ sharedWith: { some: { userId } } }`, with no
        // status. A PENDING or DECLINED recipient received the note whole: title,
        // content and searchText (N1). Every other access check in the codebase —
        // checkNoteAccess above, getBoard's filter, Hocuspocus onAuthenticate —
        // requires ACCEPTED; this one silently did not.
        { isVault: false, sharedWith: { some: { userId, status: 'ACCEPTED' } } }
      ]
    },
    include: {
      tags: { where: { userId }, include: { tag: true } },
      attachments: {
        where: { isLatest: true }
      },
      sharedWith: {
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true
            }
          }
        }
      },
      user: {
        select: {
          id: true,
          name: true,
          email: true
        }
      }
    }
  });
};

export const updateNote = async (userId: string, id: string, data: {
  title?: string;
  content?: string;
  notebookId?: string;
  isTrashed?: boolean;
  reminderDate?: string | null;
  isReminderDone?: boolean;
  isPinned?: boolean;
  isVault?: boolean;
  isEncrypted?: boolean;
  tags?: { tag: { id: string } }[];
  baseHash?: string;
}) => {
  // Verify ownership first
  const note = await prisma.note.findFirst({ where: { id, userId } });
  if (!note) throw new NotFoundError('errors.notes.notFound');

  // baseHash is only a CAS token: it must never reach Prisma, guard or not.
  const { tags, baseHash, ...rest } = data;

  // Vault P1: read only when the note is, or is becoming, a vault note (normal notes: no extra query).
  const guard = (note.isVault || rest.isVault === true) ? await getVaultGuard(userId) : null;

  // P3: the target notebook must be the caller's own, as createNote already requires.
  if (rest.notebookId !== undefined) {
    const nb = await prisma.notebook.findFirst({
      where: { id: rest.notebookId, userId },
      select: { id: true },
    });
    if (!nb) throw new NotFoundError('errors.notebooks.notFound');
  }

  // P4: only the caller's own tags are ever attached, as addTagToNote already requires.
  // [BACKUP] 2026-09-29 — a foreign or missing id used to throw
  // NotFoundError('errors.tags.noteOrTagNotFound') for the whole list. The sync push
  // then dropped the queued update, losing the tag just added along with a tag deleted
  // on another device. Dropping the unowned ids keeps P4 closed (no foreign row is
  // ever written) without failing the rest.
  let tagIds: string[] | undefined;
  if (tags !== undefined) {
    const ids = [...new Set(tags.map((t) => t.tag.id))];
    if (ids.length > 0) {
      const owned = await prisma.tag.findMany({
        where: { id: { in: ids }, userId },
        select: { id: true },
      });
      const ownedIds = new Set(owned.map((t) => t.id));
      tagIds = ids.filter((tagId) => ownedIds.has(tagId));
    } else {
      tagIds = [];
    }
  }

  // Moving a note INTO the vault: it must stop being shared (vault notes are owner-only).
  const movingToVault = rest.isVault === true && !note.isVault;
  const movingOutOfVault = rest.isVault === false && note.isVault;

  // Vault P1 enforcement (only with a keyring). Metadata-only writes are never checked (RT-4).
  if (guard) {
    if (movingToVault) {
      if (await prisma.attachment.count({ where: { noteId: id } }) > 0) throw new AppError(422, 'errors.vault.attachmentsBlocked');
      if (rest.content === undefined) throw new AppError(422, 'errors.vault.plaintextRejected');
      assertVaultContent(rest.content, guard, baseHash, note.content);
      rest.title = '';
      rest.isEncrypted = true;
    } else if (movingOutOfVault) {
      if (!guard.ready) throw new AppError(422, 'errors.vault.notReady');
      if (rest.content === undefined || parseEnvelope(rest.content) !== null) {
        throw new AppError(422, 'errors.vault.plaintextRequired');
      }
      if (!baseHash || baseHash !== sha256hex(note.content)) {
        throw new AppError(422, 'errors.vault.conflict');
      }
      rest.isEncrypted = false;
    } else if (note.isVault) {
      if (rest.title !== undefined && rest.title !== '') {
        throw new AppError(422, 'errors.vault.plaintextRejected');
      }
      if (rest.isEncrypted === false) throw new AppError(422, 'errors.vault.plaintextRejected');
      if (rest.content !== undefined) {
        assertVaultContent(rest.content, guard, baseHash, note.content);
        rest.isEncrypted = true;
      }
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    if (movingToVault) {
      await tx.sharedNote.deleteMany({ where: { noteId: id } });
    }
    if (tagIds !== undefined) {
      // Replace tags FOR THIS USER ONLY (not other users' tag associations)
      await tx.tagsOnNotes.deleteMany({ where: { noteId: id, userId } });
      if (tagIds.length > 0) {
        await tx.tagsOnNotes.createMany({
          data: tagIds.map(tagId => ({
            noteId: id,
            tagId,
            userId,
          }))
        });
      }
    }

    // [BACKUP] 2026-06-10 — inline guard replaced by shared guardEmptyContentOverwrite()
    // Guard: prevent overwriting substantial content with an empty TipTap doc.
    const { content: contentField, ...restWithoutContent } = rest;
    let finalContent = contentField;
    if (contentField !== undefined) {
      // Vault P1: with a keyring the 150-char guard would silently drop short envelopes / plaintext on exit.
      finalContent = guard ? contentField : guardEmptyContentOverwrite(note.content, contentField);
    }

    // Recalculate searchText if content changed
    const updateData: Record<string, unknown> = { ...restWithoutContent, updatedAt: new Date() };
    if (finalContent !== undefined) {
      updateData.content = finalContent;
    }
    // searchText is derived plaintext: never (re)computed while the note is, or stays, in the vault.
    // Moving OUT of the vault re-derives it from the stored content (it was nulled on the way in).
    const staysInVault = rest.isVault ?? note.isVault;
    const searchSource = finalContent ?? (movingOutOfVault ? note.content : undefined);
    if (searchSource && !staysInVault && !rest.isEncrypted && !note.isEncrypted) {
      updateData.searchText = extractTextFromTipTapJson(searchSource);
    }
    if (movingToVault) {
      updateData.isPublic = false;
      updateData.shareId = null;
      updateData.ydocState = null; // no collaborative state survives in the clear
      updateData.searchText = null; // no derived plaintext either
    }
    // Vault P1: leaving with a keyring — note.isEncrypted is still true, so the branch above skipped it.
    if (guard && movingOutOfVault && note.noteType === 'NOTE' && contentField !== undefined) {
      updateData.searchText = extractTextFromTipTapJson(contentField);
    }

    if (finalContent !== undefined && finalContent !== note.content) {
      try {
        await snapshotPreviousVersion(tx, id, note.content, note.title);
      } catch (snapErr) {
        // versioning is best-effort — never block the primary save
        logger.warn({ snapErr, noteId: id }, 'updateNote: snapshot failed — save will proceed');
      }
    }

    // Vault P1: atomic CAS on content (the read of `note` is outside this transaction).
    // A 422 here rolls back the snapshot too. Without guard or content: unchanged `update` (RT-5).
    if (guard && contentField !== undefined) {
      const r = await tx.note.updateMany({ where: { id, content: note.content }, data: updateData });
      if (r.count === 0) throw new AppError(422, 'errors.vault.conflict');
      return tx.note.findUniqueOrThrow({ where: { id } });
    }

    return tx.note.update({
      where: { id },
      data: updateData,
    });
  });

  // Best-effort: close EVERY live collab connection of the document (ex-collaborators and the
  // owner's other devices alike; onAuthenticate only checks at connect, and reconnects now get
  // Forbidden because the note is a vault note).
  if (movingToVault) {
    try {
      hocuspocus.hocuspocus.closeConnections(id);
    } catch (err) {
      logger.warn({ err, noteId: id }, 'updateNote: could not close collab sessions after move to vault');
    }
  }

  return updated;
};

export const toggleShare = async (userId: string, id: string) => {
  const note = await prisma.note.findFirst({ where: { id, userId } });
  if (!note) throw new NotFoundError('errors.notes.notFound');

  if (note.isVault) {
    throw new BadRequestError('errors.sharing.vaultNotShareable');
  }

  const isPublic = !note.isPublic;
  const shareId = isPublic ? uuidv4() : null;

  return prisma.note.update({
    where: { id },
    data: { isPublic, shareId, updatedAt: new Date() }
  });
};

export const getPublicNote = async (shareId: string) => {
  return prisma.note.findFirst({
    where: { shareId, isVault: false },
    include: {
      tags: { include: { tag: true } },
      attachments: { where: { isLatest: true } }
    }
  });
};

export const getNoteSizeBreakdown = async (userId: string, noteId: string) => {
  const access = await checkNoteAccess(userId, noteId);
  if (!access) throw new NotFoundError('errors.notes.notFound');

  const [note, attachments, chatMessages, aiConversations] = await Promise.all([
    prisma.note.findUnique({
      where: { id: noteId },
      select: { title: true, content: true, searchText: true, ydocState: true },
    }),
    prisma.attachment.findMany({
      where: { noteId },
      select: { size: true },
    }),
    prisma.chatMessage.findMany({
      where: { noteId },
      select: { content: true },
    }),
    prisma.aiConversation.findMany({
      where: { noteId },
      select: { content: true, metadata: true },
    }),
  ]);

  if (!note) throw new NotFoundError('errors.notes.notFound');

  const noteSize =
    Buffer.byteLength(note.title || '', 'utf8') +
    Buffer.byteLength(note.content || '', 'utf8') +
    Buffer.byteLength(note.searchText || '', 'utf8') +
    (note.ydocState ? note.ydocState.length : 0);

  const { characters, lines } = countDocumentStats(note.content || '');

  const attachmentsSize = attachments.reduce((sum, a) => sum + a.size, 0);
  const chatSize = chatMessages.reduce((sum, m) => sum + Buffer.byteLength(m.content, 'utf8'), 0);
  const aiSize = aiConversations.reduce((sum, c) => {
    let s = Buffer.byteLength(c.content, 'utf8');
    if (c.metadata) s += Buffer.byteLength(JSON.stringify(c.metadata), 'utf8');
    return sum + s;
  }, 0);

  return {
    note: noteSize,
    attachments: attachmentsSize,
    chat: chatSize,
    ai: aiSize,
    total: noteSize + attachmentsSize + chatSize + aiSize,
    characters,
    lines,
  };
};

export const deleteNote = async (userId: string, id: string) => {
  const result = await prisma.$transaction(async (tx) => {
    // Check ownership FIRST before deleting any relations
    const note = await tx.note.findFirst({ where: { id, userId } });
    if (!note) throw new NotFoundError('errors.notes.notFound');

    await tx.tagsOnNotes.deleteMany({ where: { noteId: id } });
    await tx.attachment.deleteMany({ where: { noteId: id } });
    await tx.sharedNote.deleteMany({ where: { noteId: id } });
    await tx.chatMessage.deleteMany({ where: { noteId: id } });

    return tx.note.delete({ where: { id } });
  });

  // Hocuspocus resolves note access once, at connect, and never re-checks: without this
  // every collaborator keeps an editing session open on a note row that no longer
  // exists, and their edits die in the store() catch instead of anywhere visible.
  hocuspocus.hocuspocus.closeConnections(id);

  logEvent(userId, 'NOTE_DELETED', { noteId: id });

  return result;
};
