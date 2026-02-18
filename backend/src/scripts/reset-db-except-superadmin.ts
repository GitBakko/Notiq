
import 'dotenv/config';
import prisma from '../plugins/prisma';

const resetDbExceptSuperAdmin = async () => {
  try {
    console.log('Starting DB cleanup (preserving SuperAdmin)...');

    // 1. Identify SuperAdmin(s)
    const superAdmins = await prisma.user.findMany({
      where: { role: 'SUPERADMIN' },
      select: { id: true, email: true }
    });

    const superAdminIds = superAdmins.map(u => u.id);
    console.log(`Found ${superAdmins.length} SuperAdmins to preserve: ${superAdmins.map(u => u.email).join(', ')}`);

    if (superAdminIds.length === 0) {
      console.warn('No SuperAdmins found. ALL data will be wiped.');
    }

    // 2. Delete data related to non-superadmin users
    // Dependencies first:
    // - AuditLog
    // - ChatMessage
    // - Notification (PushSubscription)
    // - SharedNote / SharedNotebook
    // - TagsOnNotes
    // - Attachment
    // - Note
    // - Tag
    // - Notebook
    // - Invitation (created by or used by)
    // - User

    // Ideally, we can just delete Users NOT IN superAdminIds. 
    // Cascade delete should handle most relations if schema is configured with onDelete: Cascade.
    // Let's check schema. User has cascade on:
    // - notebooks? (Notebook model has `user User @relation(..., onDelete: Cascade)`? NO. Default is usually SetNull or restrict if not specified?)
    // Checking schema:
    // `user User @relation(fields: [userId], references: [id])` -> No Cascade specified on Notebook.
    // `note Note @relation(fields: [noteId], references: [id], onDelete: Cascade)` -> Yes for ChatMessage.

    // We need to be careful. The safest way is to manual delete from leaves up or enable cascades.
    // Let's assume we want to do it clean.

    const whereNotSuperAdmin = {
      userId: { notIn: superAdminIds }
    };

    const whereUserNotSuperAdmin = {
      id: { notIn: superAdminIds }
    };

    console.log('Deleting Shared Items...');
    await prisma.sharedNote.deleteMany({ where: whereNotSuperAdmin });
    await prisma.sharedNotebook.deleteMany({ where: whereNotSuperAdmin });

    console.log('Deleting Content...');
    // Recursive deletions based on ownership
    // Notes and Notebooks owned by regular users

    // Notes
    await prisma.attachment.deleteMany({ where: { note: { userId: { notIn: superAdminIds } } } });
    await prisma.tagsOnNotes.deleteMany({ where: { note: { userId: { notIn: superAdminIds } } } });
    await prisma.chatMessage.deleteMany({ where: { userId: { notIn: superAdminIds } } });
    // Also delete messages on Notes owned by deleted users? Cascade handling would be better.

    await prisma.note.deleteMany({ where: whereNotSuperAdmin });
    await prisma.notebook.deleteMany({ where: whereNotSuperAdmin });
    await prisma.tag.deleteMany({ where: whereNotSuperAdmin });

    console.log('Deleting Ancillary Data...');
    await prisma.notification.deleteMany({ where: whereNotSuperAdmin });
    await prisma.pushSubscription.deleteMany({ where: whereNotSuperAdmin });
    await prisma.auditLog.deleteMany({ where: whereNotSuperAdmin });

    console.log('Deleting Invitations...');
    // Delete invitations created by regular users OR used by regular users
    await prisma.invitation.deleteMany({
      where: {
        OR: [
          { creatorId: { notIn: superAdminIds } },
          { usedById: { notIn: superAdminIds } }
        ]
      }
    });

    console.log('Deleting Users...');
    const deletedUsers = await prisma.user.deleteMany({
      where: whereUserNotSuperAdmin,
    });

    console.log(`Deleted ${deletedUsers.count} users and their data.`);
    console.log('Cleanup complete.');

  } catch (error) {
    console.error('Error resetting DB:', error);
  } finally {
    await prisma.$disconnect();
  }
};

resetDbExceptSuperAdmin();
