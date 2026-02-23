import prisma from '../plugins/prisma';
import * as auditService from './audit.service';
import * as emailService from './email.service';
import * as notificationService from './notification.service';
import jwt from 'jsonwebtoken';
import { Permission, ShareStatus } from '@prisma/client';
import logger from '../utils/logger';

export const shareNote = async (ownerId: string, noteId: string, targetEmail: string, permission: Permission) => {
  // Verify ownership
  const note = await prisma.note.findUnique({
    where: { id: noteId },
  });

  if (!note || note.userId !== ownerId) {
    throw new Error('Note not found or access denied');
  }

  // Find target user
  const targetUser = await prisma.user.findUnique({
    where: { email: targetEmail },
  });

  if (!targetUser) {
    throw new Error('User not found');
  }

  if (targetUser.id === ownerId) {
    throw new Error('Cannot share with yourself');
  }

  // Create Check (don't upsert directly if we want to handle re-invites differently?)
  // For now, upsert is fine. usage of PENDING default applies on create.
  // If updating, we might want to reset to PENDING if they were DECLINED?
  // Let's assume standard upsert for now.

  const sharedNote = await prisma.sharedNote.upsert({
    where: {
      noteId_userId: {
        noteId,
        userId: targetUser.id,
      },
    },
    update: {
      permission,
      status: 'PENDING', // Reset to pending on re-share/update? Or only if previously declined? Let's say always re-confirm for security if changing perms/resharing.
    },
    create: {
      noteId,
      userId: targetUser.id,
      permission,
      status: 'PENDING',
    },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },
    },
  });

  // Audit Log
  await auditService.logEvent(ownerId, 'SHARE_SENT', { noteId, targetEmail, permission });

  // Generate Invite Token
  const token = jwt.sign(
    { noteId, userId: targetUser.id, type: 'NOTE' },
    process.env.JWT_SECRET!,
    { expiresIn: '7d' }
  );

  // Send Invitation Email
  const owner = await prisma.user.findUnique({ where: { id: ownerId } });

  if (owner) {
    try {
      await emailService.sendNotificationEmail(
        targetUser.email,
        'SHARE_INVITATION',
        {
          sharerName: owner.name || owner.email,
          itemName: note.title,
          itemType: 'Note',
          token,
        }
      );

      // Optional: Notify via App (Pending Invite)
      await notificationService.createNotification(
        targetUser.id,
        'SHARE_NOTE', // Keep generic or specific INVITE type? Existing logic uses SHARE_NOTE.
        'Collaboration Invitation',
        `${owner.name || owner.email} invited you to collaborate on note: ${note.title}`,
        {
          noteId,
          noteTitle: note.title,
          sharerName: owner.name || owner.email,
          status: 'PENDING',
          localizationKey: 'notifications.shareNote',
          localizationArgs: { sharerName: owner.name || owner.email, itemName: note.title },
        }
      );

    } catch (e) {
      logger.error(e, 'Failed to send share invitation');
    }
  }

  return sharedNote;
};

export const revokeNoteShare = async (ownerId: string, noteId: string, targetUserId: string) => {
  // Verify ownership
  const note = await prisma.note.findUnique({
    where: { id: noteId },
  });

  if (!note || note.userId !== ownerId) {
    throw new Error('Note not found or access denied');
  }

  return prisma.sharedNote.delete({
    where: {
      noteId_userId: {
        noteId,
        userId: targetUserId,
      },
    },
  });
};

/**
 * Auto-share a note with specific users in the context of a Kanban board.
 * Creates SharedNote records with ACCEPTED status (auto-accepted).
 * Sends a confirmation email + in-app notification.
 */
export const autoShareNoteForBoard = async (
  ownerId: string,
  noteId: string,
  targetUserIds: string[],
  permission: Permission,
  boardTitle: string
): Promise<void> => {
  const note = await prisma.note.findUnique({ where: { id: noteId }, select: { title: true, userId: true } });
  if (!note) throw new Error('Note not found');
  if (note.userId !== ownerId) throw new Error('Only the note owner can share it');

  const owner = await prisma.user.findUnique({ where: { id: ownerId }, select: { name: true, email: true } });
  const sharerName = owner?.name || owner?.email || '?';

  for (const targetUserId of targetUserIds) {
    if (targetUserId === ownerId) continue;

    try {
      await prisma.sharedNote.upsert({
        where: { noteId_userId: { noteId, userId: targetUserId } },
        update: { permission, status: 'ACCEPTED' },
        create: { noteId, userId: targetUserId, permission, status: 'ACCEPTED' },
      });

      // In-app notification
      const targetUser = await prisma.user.findUnique({ where: { id: targetUserId }, select: { email: true, name: true } });
      if (targetUser) {
        await notificationService.createNotification(
          targetUserId,
          'SHARE_NOTE',
          'Note shared via Kanban',
          `${sharerName} shared note "${note.title}" with you via board "${boardTitle}"`,
          {
            noteId,
            noteTitle: note.title,
            sharerName,
            boardTitle,
            status: 'ACCEPTED',
            localizationKey: 'notifications.noteSharedViaKanban',
            localizationArgs: { sharerName, noteTitle: note.title, boardTitle },
          }
        );

        // Confirmation email
        await emailService.sendNotificationEmail(
          targetUser.email,
          'SHARE_INVITATION',
          {
            sharerName,
            itemName: note.title,
            itemType: 'Note',
            token: '', // No token needed, auto-accepted
          }
        ).catch((e) => logger.error(e, 'Failed to send auto-share email'));
      }
    } catch (err) {
      logger.warn({ err, noteId, targetUserId }, 'Failed to auto-share note for board');
    }
  }
};

export const getAcceptedSharedNotes = async (userId: string) => {
  const shared = await prisma.sharedNote.findMany({
    where: { userId, status: 'ACCEPTED' },
    select: {
      permission: true,
      note: {
        select: {
          id: true, title: true, content: true, searchText: true,
          notebookId: true, userId: true,
          isPinned: true, isTrashed: true, isEncrypted: true,
          isPublic: true, isVault: true, shareId: true,
          reminderDate: true, isReminderDone: true,
          createdAt: true, updatedAt: true,
          tags: { include: { tag: true } },
          attachments: {
            where: { isLatest: true },
            select: { id: true, filename: true, mimeType: true, size: true }
          },
          sharedWith: {
            include: { user: { select: { id: true, name: true, email: true } } }
          },
          user: { select: { id: true, name: true, email: true } },
        }
      }
    }
  });
  return shared.map(sn => ({ ...sn.note, _sharedPermission: sn.permission }));
};

export const getSharedNotes = async (userId: string) => {
  return prisma.sharedNote.findMany({
    where: {
      userId,
    },
    include: {
      note: {
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
      },
    },
  });
};

export const shareNotebook = async (ownerId: string, notebookId: string, targetEmail: string, permission: Permission) => {
  // Verify ownership
  const notebook = await prisma.notebook.findUnique({
    where: { id: notebookId },
  });

  if (!notebook || notebook.userId !== ownerId) {
    throw new Error('Notebook not found or access denied');
  }

  // Find target user
  const targetUser = await prisma.user.findUnique({
    where: { email: targetEmail },
  });

  if (!targetUser) {
    throw new Error('User not found');
  }

  if (targetUser.id === ownerId) {
    throw new Error('Cannot share with yourself');
  }

  const sharedNotebook = await prisma.sharedNotebook.upsert({
    where: {
      notebookId_userId: {
        notebookId,
        userId: targetUser.id,
      },
    },
    update: {
      permission,
      status: 'PENDING',
    },
    create: {
      notebookId,
      userId: targetUser.id,
      permission,
      status: 'PENDING',
    },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },
    },
  });

  // Audit Log
  await auditService.logEvent(ownerId, 'SHARE_SENT', { notebookId, targetEmail, permission });

  // Generate Invite Token
  const token = jwt.sign(
    { notebookId, userId: targetUser.id, type: 'NOTEBOOK' },
    process.env.JWT_SECRET!,
    { expiresIn: '7d' }
  );


  // Send Invite
  const owner = await prisma.user.findUnique({ where: { id: ownerId } });

  if (owner) {
    try {
      await emailService.sendNotificationEmail(
        targetUser.email,
        'SHARE_INVITATION',
        {
          sharerName: owner.name || owner.email,
          itemName: notebook.name,
          itemType: 'Notebook',
          token,
          locale: (targetUser as any).locale
        }
      );

      await notificationService.createNotification(
        targetUser.id,
        'SHARE_NOTEBOOK',
        'Collaboration Invitation',
        `${owner.name || owner.email} invited you to collaborate on notebook: ${notebook.name}`,
        {
          notebookId,
          notebookName: notebook.name,
          sharerName: owner.name || owner.email,
          status: 'PENDING',
          localizationKey: 'notifications.shareNotebook',
          localizationArgs: { sharerName: owner.name || owner.email, itemName: notebook.name }
        }
      );
    } catch (e) {
      logger.error(e, 'Failed to send share notebook notification');
    }
  }

  return sharedNotebook;
};

export const revokeNotebookShare = async (ownerId: string, notebookId: string, targetUserId: string) => {
  // Verify ownership
  const notebook = await prisma.notebook.findUnique({
    where: { id: notebookId },
  });

  if (!notebook || notebook.userId !== ownerId) {
    throw new Error('Notebook not found or access denied');
  }

  return prisma.sharedNotebook.delete({
    where: {
      notebookId_userId: {
        notebookId,
        userId: targetUserId,
      },
    },
  });
};

export const getSharedNotebooks = async (userId: string) => {
  return prisma.sharedNotebook.findMany({
    where: {
      userId,
    },
    include: {
      notebook: {
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
      },
    },
  });
};

export const respondToShare = async (token: string, action: 'accept' | 'decline') => {
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
    const { userId, type } = decoded;
    const noteId = decoded.noteId;
    const notebookId = decoded.notebookId;

    const status = action === 'accept' ? 'ACCEPTED' : 'DECLINED';

    let result;
    if (type === 'NOTE') {
      result = await prisma.sharedNote.update({
        where: {
          noteId_userId: {
            noteId,
            userId,
          },
        },
        data: { status },
        include: { note: { include: { user: true } }, user: true }
      });
    } else if (type === 'NOTEBOOK') {
      result = await prisma.sharedNotebook.update({
        where: {
          notebookId_userId: {
            notebookId,
            userId,
          },
        },
        data: { status },
        include: { notebook: { include: { user: true } }, user: true }
      });
    }

    // Notify Owner
    if (result) {
      const owner = type === 'NOTE' ? (result as any).note.user : (result as any).notebook.user;
      const responder = (result as any).user;
      const itemName = type === 'NOTE' ? (result as any).note.title : (result as any).notebook.name;

      if (owner) {
        await emailService.sendNotificationEmail(
          owner.email,
          'SHARE_RESPONSE',
          {
            responderName: responder.name || responder.email,
            action: action === 'accept' ? 'accepted' : 'declined', // Past tense for email
            itemName,
            itemId: type === 'NOTE' ? noteId : notebookId,
          }
        );

        await notificationService.createNotification(
          owner.id,
          'SYSTEM',
          'Invitation Update',
          `${responder.name || responder.email} ${action}ed your invitation to ${itemName}`,
          {
            itemId: type === 'NOTE' ? noteId : notebookId,
            type,
            action,
            responderName: responder.name || responder.email,
            itemName,
            localizationKey: action === 'accept' ? 'notifications.shareResponseAccepted' : 'notifications.shareResponseDeclined',
            localizationArgs: { responderName: responder.name || responder.email, itemName },
          }
        );
      }
    }

    return { success: true, status };
  } catch (error) {
    throw new Error('Invalid or expired token');
  }
};


export const respondToShareById = async (userId: string, itemId: string, type: 'NOTE' | 'NOTEBOOK' | 'KANBAN', action: 'accept' | 'decline') => {
  const status = action === 'accept' ? 'ACCEPTED' : 'DECLINED';

  let result;
  if (type === 'NOTE') {
    // Check existence
    const existing = await prisma.sharedNote.findUnique({
      where: { noteId_userId: { noteId: itemId, userId } }
    });
    if (!existing) throw new Error('Invitation not found');

    result = await prisma.sharedNote.update({
      where: {
        noteId_userId: {
          noteId: itemId,
          userId,
        },
      },
      data: { status },
      include: { note: { include: { user: true } }, user: true }
    });
  } else if (type === 'NOTEBOOK') {
    const existing = await prisma.sharedNotebook.findUnique({
      where: { notebookId_userId: { notebookId: itemId, userId } }
    });
    if (!existing) throw new Error('Invitation not found');

    result = await prisma.sharedNotebook.update({
      where: {
        notebookId_userId: {
          notebookId: itemId,
          userId,
        },
      },
      data: { status },
      include: { notebook: { include: { user: true } }, user: true }
    });
  } else if (type === 'KANBAN') {
    const existing = await prisma.sharedKanbanBoard.findUnique({
      where: { boardId_userId: { boardId: itemId, userId } }
    });
    if (!existing) throw new Error('Invitation not found');

    result = await prisma.sharedKanbanBoard.update({
      where: {
        boardId_userId: {
          boardId: itemId,
          userId,
        },
      },
      data: { status },
      include: { board: { include: { owner: true } }, user: true }
    });
  }

  // Notify Owner
  if (result) {
    let owner: any;
    let itemName: string;
    if (type === 'NOTE') {
      owner = (result as any).note.user;
      itemName = (result as any).note.title;
    } else if (type === 'NOTEBOOK') {
      owner = (result as any).notebook.user;
      itemName = (result as any).notebook.name;
    } else {
      owner = (result as any).board.owner;
      itemName = (result as any).board.title;
    }
    const responder = (result as any).user;

    if (owner) {
      await emailService.sendNotificationEmail(
        owner.email,
        'SHARE_RESPONSE',
        {
          responderName: responder.name || responder.email,
          action: action === 'accept' ? 'accepted' : 'declined',
          itemName,
          itemId,
        }
      );

      await notificationService.createNotification(
        owner.id,
        'SYSTEM',
        'Invitation Update',
        `${responder.name || responder.email} ${action}ed your invitation to ${itemName}`,
        {
          itemId,
          type,
          action,
          responderName: responder.name || responder.email,
          itemName,
          localizationKey: action === 'accept' ? 'notifications.shareResponseAccepted' : 'notifications.shareResponseDeclined',
          localizationArgs: { responderName: responder.name || responder.email, itemName },
        }
      );
    }
  }

  return { success: true, status };
};

// ─── Kanban Board Sharing ───────────────────────────────────

export const shareKanbanBoard = async (
  ownerId: string,
  boardId: string,
  email: string,
  permission: Permission = 'READ'
) => {
  const board = await prisma.kanbanBoard.findUnique({
    where: { id: boardId },
    select: { title: true, ownerId: true },
  });
  if (!board) throw new Error('Board not found');
  if (board.ownerId !== ownerId) throw new Error('Not the owner');

  const targetUser = await prisma.user.findUnique({ where: { email } });
  if (!targetUser) throw new Error('User not found');
  if (targetUser.id === ownerId) throw new Error('Cannot share with yourself');

  const share = await prisma.sharedKanbanBoard.upsert({
    where: { boardId_userId: { boardId, userId: targetUser.id } },
    update: { permission, status: 'PENDING' },
    create: { boardId, userId: targetUser.id, permission, status: 'PENDING' },
    include: { user: { select: { id: true, name: true, email: true } } },
  });

  const sharer = await prisma.user.findUnique({
    where: { id: ownerId },
    select: { name: true, email: true },
  });
  const sharerName = sharer?.name || sharer?.email || 'Someone';

  await notificationService.createNotification(
    targetUser.id,
    'KANBAN_BOARD_SHARED',
    'Board Shared',
    `${sharerName} shared "${board.title}" with you`,
    {
      boardId,
      boardTitle: board.title,
      sharerName,
      localizationKey: 'notifications.kanbanBoardShared',
      localizationArgs: { sharerName, itemName: board.title },
    }
  );

  try {
    await emailService.sendNotificationEmail(email, 'SHARE_INVITATION', {
      sharerName,
      itemName: board.title,
      itemType: 'kanban board',
    });
  } catch {
    // Email failure should not block sharing
  }

  return share;
};

export const revokeKanbanBoardShare = async (
  ownerId: string,
  boardId: string,
  targetUserId: string
) => {
  const board = await prisma.kanbanBoard.findUnique({
    where: { id: boardId },
    select: { ownerId: true },
  });
  if (!board) throw new Error('Board not found');
  if (board.ownerId !== ownerId) throw new Error('Not the owner');

  try {
    await prisma.sharedKanbanBoard.delete({
      where: { boardId_userId: { boardId, userId: targetUserId } },
    });
  } catch {
    // Record may not exist — treat as success
  }
  return { success: true };
};
