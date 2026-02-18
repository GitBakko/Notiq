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
    // 1. Check if user is active on the SPECIFIC note (Hocuspocus) -> Live update, no notification needed (or handled by frontend)
    // Actually, user wants:
    // Case 1: Note Open (Hocuspocus) -> Sound + Badge (handled by frontend events usually, but here we just DON'T send email/push).
    // The frontend ChatSidebar polling/socket handles the "Sound + Badge".
    // We just need to decide about EMAIL and IN-APP notification.

    // Logic:
    // If Active on Note (Hocuspocus):
    //    - NO Email.
    //    - NO In-App Notification (User sees it). 
    //      wait, user said: "Se l'utente 2 è loggato all'app ed ha la nota aperta: NON riceve una notifica in app"
    //      So we skip createNotification too? 
    //      "Sente il suono di notifica ... e compare un bullet" -> This is frontend state.
    //      So Backend should NOT create a persistent Notification? 
    //      If we don't create a Notification, the user won't see it in "Unread Messages" later if they navigate away? 
    //      Usually "In-App Notification" implies the bell icon list. 
    //      The user said: "NON riceve una notifica in app". This likely means the "toast" or "bell" item.
    //      Let's assume we skip `notificationService.createNotification` if active on note.

    const isActiveOnNote = activeUserIds.has(recipientId);

    // Get recipient email/details
    const recipient = recipientId === note.userId ? note.user : note.sharedWith.find(s => s.userId === recipientId)?.user;
    if (!recipient) continue;

    if (isActiveOnNote) {
      // Case 2: User logged in, note open
      // NON riceve una notifica in app (skip DB notification)
      // NON riceve una notifica email (skip Email)
      // Frontend handles sound/badge via polling/ws
      continue;
    }

    // Check if user is "logged in anywhere" (Online in App but seemingly not on this note)
    // We check lastActiveAt. Let's say "Online" means active in last 5 minutes.
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    // We need to fetch the user's latest lastActiveAt (the one in 'note' include might be stale? No, prisma fetches fresh)
    // Actually 'note.sharedWith.include.user' fetches the user.
    // Let's refetch recipient to be sure or trust the include.
    // We didn't include 'lastActiveAt' in the findUnique for note. We need to.

    // We can just query the user's status or trust the passed recipient object if we update the query.
    // Let's rely on a fresh fetch or update the upstream query. 
    // Updating upstream query is better. I will assume I updated the query in the `createMessage` function start? 
    // No, I can't change the previous lines easily without replacing the whole function. 
    // I am replacing the LOOP. I can just fetch the user status here or simpler:
    // Let's just use the `recipient` object and Ensure we select `lastActiveAt` in the initial query.
    // Wait, the initial query is outside this block. I should probably replace the WHOLE function to be safe and clean.

    // But for now, let's assume I can inspect `recipient` and if I can't, I'll fetch.
    // Actually, I'll just do a quick check:
    const freshRecipient = await prisma.user.findUnique({
      where: { id: recipientId },
      select: { lastActiveAt: true, email: true, locale: true } // minimal fetch
    });

    const isOnlineInApp = freshRecipient?.lastActiveAt && freshRecipient.lastActiveAt > fiveMinutesAgo;

    // Create App Notification (for Bell Icon) - User said:
    // "Se l'utente 2 è loggato all'app e NON ha la nota aperta: riceve una notifica in app"
    // "Se l'utente 2 NON è loggato all'app: NON riceve una notifica in app" -> Wait, really? 
    // Usually offline users SHOULD get a notification in the bell so they see it when they come back.
    // But the user explicitly said "NON riceve una notifica in app" for Case 3.
    // This is weird. "NON riceve una notifica in app" probably means "Push/Toast"? 
    // But "riceve una notifica email".
    // If I interpret "Notifica in app" as "Persistent Notification in DB":
    // Case 1 (On Note): No DB Notif.
    // Case 2 (In App, Not on Note): YES DB Notif.
    // Case 3 (Offline): NO DB Notif? That implies they lose the history of notification. 
    // I suspect the user means "Don't send a PUSH/Toast immediately" or maybe they really mean "Only Email".
    // I will follow instructions LITERALLY: 
    // Case 3: Offline -> Email ONLY. No DB Notification.

    if (isOnlineInApp) {
      // Case 1: Online, Not on Note
      // riceve una notifica in app
      // NON riceve una notifica email
      await notificationService.createNotification(
        recipientId,
        'CHAT_MESSAGE',
        'New Chat Message',
        `${senderName} commented: "${content.substring(0, 50)}${content.length > 50 ? '...' : ''}"`,
        { noteId, noteTitle: note.title, senderName, messageContent: content }
      );
    } else {
      // Case 3: Offline
      // NON riceve una notifica in app
      // riceve una notifica email
      await emailService.sendNotificationEmail(
        freshRecipient!.email,
        'CHAT_MESSAGE',
        { noteId, noteTitle: note.title, senderName, messageContent: content, locale: freshRecipient?.locale }
      );
    }
  }

  return message;
};

export const getMessages = async (noteId: string, page: number = 1, limit: number = 100) => {
  return prisma.chatMessage.findMany({
    where: { noteId },
    orderBy: { createdAt: 'asc' },
    skip: (page - 1) * limit,
    take: limit,
    include: {
      user: {
        select: { id: true, name: true, email: true }
      }
    }
  });
};
