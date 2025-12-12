import prisma from '../plugins/prisma';
import * as auditService from './audit.service';
import * as emailService from './email.service';
import * as notificationService from './notification.service';
import jwt from 'jsonwebtoken';
import { Permission, ShareStatus } from '@prisma/client';

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
    process.env.JWT_SECRET || 'supersecret',
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
        { noteId, noteTitle: note.title, sharerName: owner.name || owner.email, status: 'PENDING' }
      );

    } catch (e) {
      console.error('Failed to send share invitation', e);
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
    process.env.JWT_SECRET || 'supersecret',
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
      console.error('Failed to send share notebook notification', e);
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
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'supersecret') as any;
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
          'SYSTEM', // Or specific type
          'Invitation Update',
          `${responder.name || responder.email} ${action}ed your invitation to ${itemName}`,
          { itemId: type === 'NOTE' ? noteId : notebookId, type, action }
        );
      }
    }

    return { success: true, status };
  } catch (error) {
    throw new Error('Invalid or expired token');
  }
};


export const respondToShareById = async (userId: string, itemId: string, type: 'NOTE' | 'NOTEBOOK', action: 'accept' | 'decline') => {
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
        { itemId, type, action }
      );
    }
  }

  return { success: true, status };
};
