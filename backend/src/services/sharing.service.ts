import prisma from '../plugins/prisma';
import * as auditService from './audit.service';
import * as emailService from './email.service';
import * as notificationService from './notification.service';
import { Permission } from '@prisma/client';
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
          shareId: sharedNote.id,
          tab: 'notes',
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
            shareId: '',
            tab: 'notes',
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
          shareId: sharedNotebook.id,
          tab: 'notebooks',
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

    // Create catch-up reminders when accepting a board share
    if (action === 'accept') {
      try {
        const { createRemindersForNewBoardUser } = await import('./kanbanReminder.service');
        await createRemindersForNewBoardUser(userId, itemId);
      } catch {
        // Non-critical
      }
    }
  }

  // Notify Owner
  if (result) {
    let owner: { id: string; email: string; name: string | null } | undefined;
    let itemName: string;
    if (type === 'NOTE' && 'note' in result) {
      owner = result.note.user;
      itemName = result.note.title;
    } else if (type === 'NOTEBOOK' && 'notebook' in result) {
      owner = result.notebook.user;
      itemName = result.notebook.name;
    } else if ('board' in result) {
      owner = result.board.owner;
      itemName = result.board.title;
    } else {
      itemName = '';
    }
    const responder = result.user;

    if (owner) {
      try {
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
      } catch (err) {
        // Non-critical: don't fail the accept/decline if notification fails
      }
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
      shareId: share.id,
      tab: 'kanbanBoards',
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

  // Clean up kanban reminders for the revoked user
  try {
    const { deleteRemindersForUserOnBoard } = await import('./kanbanReminder.service');
    await deleteRemindersForUserOnBoard(targetUserId, boardId);
  } catch {
    // Non-critical
  }

  return { success: true };
};

// ─── Sent Shares & Resend ──────────────────────────────────

export const getSentShares = async (userId: string) => {
  const [notes, notebooks, taskLists, kanbanBoards] = await Promise.all([
    prisma.sharedNote.findMany({
      where: { note: { userId } },
      include: {
        user: { select: { id: true, name: true, email: true } },
        note: { select: { id: true, title: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.sharedNotebook.findMany({
      where: { notebook: { userId } },
      include: {
        user: { select: { id: true, name: true, email: true } },
        notebook: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.sharedTaskList.findMany({
      where: { taskList: { userId } },
      include: {
        user: { select: { id: true, name: true, email: true } },
        taskList: { select: { id: true, title: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.sharedKanbanBoard.findMany({
      where: { board: { ownerId: userId } },
      include: {
        user: { select: { id: true, name: true, email: true } },
        board: { select: { id: true, title: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  return { notes, notebooks, taskLists, kanbanBoards };
};

export const resendShareInvitation = async (
  userId: string,
  type: 'NOTE' | 'NOTEBOOK' | 'TASKLIST' | 'KANBAN',
  shareId: string
) => {
  const owner = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
  if (!owner) throw new Error('User not found');
  const sharerName = owner.name || owner.email;

  let targetEmail: string;
  let itemName: string;
  let itemType: string;
  let tab: string;

  if (type === 'NOTE') {
    const share = await prisma.sharedNote.findUnique({
      where: { id: shareId },
      include: { user: { select: { email: true } }, note: { select: { title: true, userId: true } } },
    });
    if (!share || share.note.userId !== userId) throw new Error('Share not found');
    if (share.status !== 'PENDING') throw new Error('Only pending shares can be resent');
    targetEmail = share.user.email;
    itemName = share.note.title;
    itemType = 'Note';
    tab = 'notes';
  } else if (type === 'NOTEBOOK') {
    const share = await prisma.sharedNotebook.findUnique({
      where: { id: shareId },
      include: { user: { select: { email: true } }, notebook: { select: { name: true, userId: true } } },
    });
    if (!share || share.notebook.userId !== userId) throw new Error('Share not found');
    if (share.status !== 'PENDING') throw new Error('Only pending shares can be resent');
    targetEmail = share.user.email;
    itemName = share.notebook.name;
    itemType = 'Notebook';
    tab = 'notebooks';
  } else if (type === 'TASKLIST') {
    const share = await prisma.sharedTaskList.findUnique({
      where: { id: shareId },
      include: { user: { select: { email: true } }, taskList: { select: { title: true, userId: true } } },
    });
    if (!share || share.taskList.userId !== userId) throw new Error('Share not found');
    if (share.status !== 'PENDING') throw new Error('Only pending shares can be resent');
    targetEmail = share.user.email;
    itemName = share.taskList.title;
    itemType = 'Task List';
    tab = 'taskLists';
  } else {
    const share = await prisma.sharedKanbanBoard.findUnique({
      where: { id: shareId },
      include: { user: { select: { email: true } }, board: { select: { title: true, ownerId: true } } },
    });
    if (!share || share.board.ownerId !== userId) throw new Error('Share not found');
    if (share.status !== 'PENDING') throw new Error('Only pending shares can be resent');
    targetEmail = share.user.email;
    itemName = share.board.title;
    itemType = 'kanban board';
    tab = 'kanbanBoards';
  }

  await emailService.sendNotificationEmail(targetEmail, 'SHARE_INVITATION', {
    sharerName,
    itemName,
    itemType,
    shareId,
    tab,
  });

  return { success: true };
};
