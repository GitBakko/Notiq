import prisma from '../plugins/prisma';
import * as notificationService from './notification.service';
import * as emailService from './email.service';
import { hocuspocus } from '../hocuspocus';

export const createMessage = async (userId: string, noteId: string, content: string) => {
  // Save message
  const message = await prisma.chatMessage.create({
    data: {
      userId,
      noteId,
      content,
    },
    include: {
      user: {
        select: { id: true, name: true, email: true }, // Add color if stored in User model? User model doesn't have color.
      }
    }
  });

  // Notify collaborators
  // 1. Get Note Owner + Shared Users
  const note = await prisma.note.findUnique({
    where: { id: noteId },
    include: {
      sharedWith: { include: { user: true } },
      user: true // Owner
    }
  });

  if (!note) return message;

  const sender = await prisma.user.findUnique({ where: { id: userId } });
  const senderName = sender?.name || sender?.email || 'Someone';

  const recipients = new Set<string>();

  // Owner (if not sender)
  if (note.userId !== userId) {
    recipients.add(note.userId);
  }

  // Shared users (if not sender)
  note.sharedWith.forEach(share => {
    if (share.userId !== userId) {
      recipients.add(share.userId);
    }
  });

  // Filter out users who are "active" in Hocuspocus (connected to the document)
  const activeUserIds = new Set<string>();

  try {
    const server = hocuspocus as any;
    const document = server.documents?.get(noteId);

    if (document) {
      document.getConnections().forEach((conn: any) => {
        // The user ID is attached to the connection context in onAuthenticate
        const context = conn.context as any;
        if (context?.user?.id) {
          activeUserIds.add(context.user.id);
        }
      });
    }
  } catch (error) {
    console.error('Error checking active users in Hocuspocus:', error);
    // Proceed without filtering if this fails
  }

  for (const recipientId of recipients) {
    // Skip if user is active on the note
    if (activeUserIds.has(recipientId)) {
      continue;
    }

    // Get recipient email/details
    const recipient = recipientId === note.userId ? note.user : note.sharedWith.find(s => s.userId === recipientId)?.user;

    if (recipient) {
      // App Notification
      await notificationService.createNotification(
        recipient.id,
        'CHAT_MESSAGE',
        'New Chat Message',
        `${senderName} commented: "${content.substring(0, 50)}${content.length > 50 ? '...' : ''}"`,
        { noteId, noteTitle: note.title, senderName, messageContent: content }
      );

      // Email Notification
      await emailService.sendNotificationEmail(
        recipient.email,
        'CHAT_MESSAGE',
        { noteId, noteTitle: note.title, senderName, messageContent: content, locale: (recipient as any).locale }
      );
    }
  }

  return message;
};

export const getMessages = async (noteId: string) => {
  return prisma.chatMessage.findMany({
    where: { noteId },
    orderBy: { createdAt: 'asc' },
    include: {
      user: {
        select: { id: true, name: true, email: true }
      }
    }
  });
};
