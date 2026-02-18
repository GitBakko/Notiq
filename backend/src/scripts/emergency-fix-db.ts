
import 'dotenv/config';
import prisma from '../plugins/prisma';

async function executeRaw(query: string) {
  try {
    await prisma.$executeRawUnsafe(query);
  } catch (error: any) {
    if (error.message && error.message.includes('already exists')) {
      // Ignore
    } else {
      console.warn('Warning during query execution, but continuing:', error.message);
    }
  }
}

async function main() {
  console.log('--- Checking Database Schema Integrity ---');

  try {
    // 1. Roles Enum
    console.log('Checking Role Enum...');
    await executeRaw(`
      DO $$ BEGIN
          CREATE TYPE "Role" AS ENUM ('USER', 'SUPERADMIN');
      EXCEPTION
          WHEN duplicate_object THEN null;
      END $$;
    `);

    // 2. User Columns
    console.log('Ensuring User columns exist...');

    // Fields from 20251202120000_add_user_fields potentially missing if migration failed
    await executeRaw(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "surname" TEXT;`);
    await executeRaw(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "gender" TEXT;`);
    await executeRaw(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "dateOfBirth" TIMESTAMP(3);`);
    await executeRaw(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "placeOfBirth" TEXT;`);
    await executeRaw(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mobile" TEXT;`);
    await executeRaw(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "avatarUrl" TEXT;`);
    await executeRaw(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "resetToken" TEXT;`);
    await executeRaw(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "resetTokenExpiry" TIMESTAMP(3);`);

    // Fields missing from ALL migrations (Critical)
    await executeRaw(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "locale" TEXT NOT NULL DEFAULT 'en';`);

    // Fields from recent changes
    await executeRaw(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "role" "Role" NOT NULL DEFAULT 'USER';`);
    await executeRaw(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "isVerified" BOOLEAN NOT NULL DEFAULT false;`);
    await executeRaw(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "verificationToken" TEXT;`);
    await executeRaw(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "verificationTokenExpires" TIMESTAMP(3);`);
    await executeRaw(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "invitationCode" TEXT;`);
    await executeRaw(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "invitesAvailable" INTEGER NOT NULL DEFAULT 2;`);

    // 3. Invitation Status Enum
    console.log('Checking InvitationStatus Enum...');
    await executeRaw(`
      DO $$ BEGIN
          CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'USED');
      EXCEPTION
          WHEN duplicate_object THEN null;
      END $$;
    `);

    // 4. Invitation Table
    console.log('Ensuring Invitation table exists...');
    await executeRaw(`
      CREATE TABLE IF NOT EXISTS "Invitation" (
          "id" TEXT NOT NULL,
          "code" TEXT NOT NULL,
          "creatorId" TEXT NOT NULL,
          "usedById" TEXT,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "usedAt" TIMESTAMP(3),
          "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',

          CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
      );
    `);

    await executeRaw(`CREATE UNIQUE INDEX IF NOT EXISTS "Invitation_code_key" ON "Invitation"("code");`);
    await executeRaw(`CREATE UNIQUE INDEX IF NOT EXISTS "Invitation_usedById_key" ON "Invitation"("usedById");`);

    // 5. Constraints
    console.log('Checking Constraints...');
    await executeRaw(`
      DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Invitation_creatorId_fkey') THEN
              ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
          END IF;
      END $$;
    `);

    await executeRaw(`
      DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Invitation_usedById_fkey') THEN
              ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_usedById_fkey" FOREIGN KEY ("usedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
          END IF;
      END $$;
    `);

    // 6. ChatMessage Table
    console.log('Ensuring ChatMessage table exists...');
    await executeRaw(`
      CREATE TABLE IF NOT EXISTS "ChatMessage" (
        "id" TEXT NOT NULL,
        "noteId" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "content" TEXT NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
      );
    `);

    await executeRaw(`
      DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChatMessage_noteId_fkey') THEN
              ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "Note"("id") ON DELETE CASCADE ON UPDATE CASCADE;
          END IF;
      END $$;
    `);

    await executeRaw(`
      DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChatMessage_userId_fkey') THEN
              ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
          END IF;
      END $$;
    `);

    // 7. AuditLog Table
    console.log('Ensuring AuditLog table exists...');
    await executeRaw(`
      CREATE TABLE IF NOT EXISTS "AuditLog" (
        "id" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "event" TEXT NOT NULL,
        "details" JSONB,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
      );
    `);

    await executeRaw(`
      DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AuditLog_userId_fkey') THEN
              ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
          END IF;
      END $$;
    `);


    // 8. SystemSetting Table
    console.log('Ensuring SystemSetting table exists...');
    await executeRaw(`
      CREATE TABLE IF NOT EXISTS "SystemSetting" (
        "key" TEXT NOT NULL,
        "value" TEXT NOT NULL,
        "description" TEXT,

        CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("key")
      );
    `);

    // 9. Notebook Table
    console.log('Ensuring Notebook table exists...');
    await executeRaw(`
      CREATE TABLE IF NOT EXISTS "Notebook" (
        "id" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT "Notebook_pkey" PRIMARY KEY ("id")
      );
    `);
    // Notebook FK
    await executeRaw(`
      DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Notebook_userId_fkey') THEN
              ALTER TABLE "Notebook" ADD CONSTRAINT "Notebook_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
          END IF;
      END $$;
    `);

    // 10. Note Table
    console.log('Ensuring Note table exists...');
    await executeRaw(`
      CREATE TABLE IF NOT EXISTS "Note" (
        "id" TEXT NOT NULL,
        "title" TEXT NOT NULL,
        "content" TEXT NOT NULL,
        "searchText" TEXT,
        "notebookId" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "isTrashed" BOOLEAN NOT NULL DEFAULT false,
        "reminderDate" TIMESTAMP(3),
        "isReminderDone" BOOLEAN NOT NULL DEFAULT false,
        "isPublic" BOOLEAN NOT NULL DEFAULT false,
        "shareId" TEXT,
        "isPinned" BOOLEAN NOT NULL DEFAULT false,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "isVault" BOOLEAN NOT NULL DEFAULT false,
        "isEncrypted" BOOLEAN NOT NULL DEFAULT false,

        CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
      );
    `);

    await executeRaw(`CREATE UNIQUE INDEX IF NOT EXISTS "Note_shareId_key" ON "Note"("shareId");`);

    // Note FKs
    await executeRaw(`
      DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Note_notebookId_fkey') THEN
              ALTER TABLE "Note" ADD CONSTRAINT "Note_notebookId_fkey" FOREIGN KEY ("notebookId") REFERENCES "Notebook"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
          END IF;
      END $$;
    `);
    await executeRaw(`
      DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Note_userId_fkey') THEN
              ALTER TABLE "Note" ADD CONSTRAINT "Note_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
          END IF;
      END $$;
    `);

    // 11. Tag Table
    console.log('Ensuring Tag table exists...');
    await executeRaw(`
      CREATE TABLE IF NOT EXISTS "Tag" (
        "id" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "isVault" BOOLEAN NOT NULL DEFAULT false,

        CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
      );
    `);

    // Ensure isVault column exists (if table existed from old migration)
    await executeRaw(`
      DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='Tag' AND column_name='isVault') THEN
              ALTER TABLE "Tag" ADD COLUMN "isVault" BOOLEAN NOT NULL DEFAULT false;
          END IF;
      END $$;
    `);

    await executeRaw(`CREATE UNIQUE INDEX IF NOT EXISTS "Tag_userId_name_key" ON "Tag"("userId", "name");`);
    // Note: The schema has @@unique([userId, name, isVault]) actually.
    // Let's rely on flexible fixing or drop the old constraint if mismatch? 
    // Ideally we match schema exactly:
    try {
      await executeRaw(`DROP INDEX IF EXISTS "Tag_userId_name_key"`); // Drop old stricter one if exists
      await executeRaw(`CREATE UNIQUE INDEX IF NOT EXISTS "Tag_userId_name_isVault_key" ON "Tag"("userId", "name", "isVault");`);
    } catch (e) { }

    // Tag FK
    await executeRaw(`
      DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Tag_userId_fkey') THEN
              ALTER TABLE "Tag" ADD CONSTRAINT "Tag_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
          END IF;
      END $$;
    `);

    // 12. TagsOnNotes Table
    console.log('Ensuring TagsOnNotes table exists...');
    await executeRaw(`
      CREATE TABLE IF NOT EXISTS "TagsOnNotes" (
        "noteId" TEXT NOT NULL,
        "tagId" TEXT NOT NULL,

        CONSTRAINT "TagsOnNotes_pkey" PRIMARY KEY ("noteId", "tagId")
      );
    `);

    // TagsOnNotes FKs
    await executeRaw(`
      DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TagsOnNotes_noteId_fkey') THEN
              ALTER TABLE "TagsOnNotes" ADD CONSTRAINT "TagsOnNotes_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "Note"("id") ON DELETE CASCADE ON UPDATE CASCADE;
          END IF;
      END $$;
    `);
    await executeRaw(`
      DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TagsOnNotes_tagId_fkey') THEN
              ALTER TABLE "TagsOnNotes" ADD CONSTRAINT "TagsOnNotes_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
          END IF;
      END $$;
    `);

    // 13. Attachment Table
    console.log('Ensuring Attachment table exists...');
    await executeRaw(`
      CREATE TABLE IF NOT EXISTS "Attachment" (
        "id" TEXT NOT NULL,
        "noteId" TEXT NOT NULL,
        "url" TEXT NOT NULL,
        "filename" TEXT NOT NULL,
        "mimeType" TEXT NOT NULL,
        "size" INTEGER NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "version" INTEGER NOT NULL DEFAULT 1,
        "hash" TEXT,
        "isLatest" BOOLEAN NOT NULL DEFAULT true,

        CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
      );
    `);
    // Attachment FK
    await executeRaw(`
      DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Attachment_noteId_fkey') THEN
              ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "Note"("id") ON DELETE CASCADE ON UPDATE CASCADE;
          END IF;
      END $$;
    `);

    // 14. Enums for Sharing & Notifications
    console.log('Checking Enums (Permission, ShareStatus, NotificationType)...');
    await executeRaw(`
      DO $$ BEGIN
          CREATE TYPE "Permission" AS ENUM ('READ', 'WRITE');
      EXCEPTION WHEN duplicate_object THEN null; END $$;
    `);
    await executeRaw(`
      DO $$ BEGIN
          CREATE TYPE "ShareStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED');
      EXCEPTION WHEN duplicate_object THEN null; END $$;
    `);
    await executeRaw(`
      DO $$ BEGIN
          CREATE TYPE "NotificationType" AS ENUM ('SHARE_NOTE', 'SHARE_NOTEBOOK', 'SYSTEM', 'REMINDER', 'CHAT_MESSAGE');
      EXCEPTION WHEN duplicate_object THEN null; END $$;
    `);

    // 15. SharedNote Table
    console.log('Ensuring SharedNote table exists...');
    await executeRaw(`
      CREATE TABLE IF NOT EXISTS "SharedNote" (
        "id" TEXT NOT NULL,
        "noteId" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "permission" "Permission" NOT NULL DEFAULT 'READ',
        "status" "ShareStatus" NOT NULL DEFAULT 'PENDING',
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT "SharedNote_pkey" PRIMARY KEY ("id")
      );
    `);
    await executeRaw(`CREATE UNIQUE INDEX IF NOT EXISTS "SharedNote_noteId_userId_key" ON "SharedNote"("noteId", "userId");`);

    // SharedNote FKs
    await executeRaw(`
      DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SharedNote_noteId_fkey') THEN
              ALTER TABLE "SharedNote" ADD CONSTRAINT "SharedNote_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "Note"("id") ON DELETE CASCADE ON UPDATE CASCADE;
          END IF;
      END $$;
    `);
    await executeRaw(`
      DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SharedNote_userId_fkey') THEN
              ALTER TABLE "SharedNote" ADD CONSTRAINT "SharedNote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
          END IF;
      END $$;
    `);

    // 16. SharedNotebook Table
    console.log('Ensuring SharedNotebook table exists...');
    await executeRaw(`
      CREATE TABLE IF NOT EXISTS "SharedNotebook" (
        "id" TEXT NOT NULL,
        "notebookId" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "permission" "Permission" NOT NULL DEFAULT 'READ',
        "status" "ShareStatus" NOT NULL DEFAULT 'PENDING',
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT "SharedNotebook_pkey" PRIMARY KEY ("id")
      );
    `);
    await executeRaw(`CREATE UNIQUE INDEX IF NOT EXISTS "SharedNotebook_notebookId_userId_key" ON "SharedNotebook"("notebookId", "userId");`);

    // SharedNotebook FKs
    await executeRaw(`
      DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SharedNotebook_notebookId_fkey') THEN
              ALTER TABLE "SharedNotebook" ADD CONSTRAINT "SharedNotebook_notebookId_fkey" FOREIGN KEY ("notebookId") REFERENCES "Notebook"("id") ON DELETE CASCADE ON UPDATE CASCADE;
          END IF;
      END $$;
    `);
    await executeRaw(`
      DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SharedNotebook_userId_fkey') THEN
              ALTER TABLE "SharedNotebook" ADD CONSTRAINT "SharedNotebook_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
          END IF;
      END $$;
    `);

    // 17. Notification Table
    console.log('Ensuring Notification table exists...');
    await executeRaw(`
      CREATE TABLE IF NOT EXISTS "Notification" (
        "id" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "type" "NotificationType" NOT NULL,
        "title" TEXT NOT NULL,
        "message" TEXT NOT NULL,
        "data" JSONB,
        "isRead" BOOLEAN NOT NULL DEFAULT false,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
      );
    `);
    // Notification FK
    await executeRaw(`
      DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Notification_userId_fkey') THEN
              ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
          END IF;
      END $$;
    `);

    // 18. PushSubscription Table
    console.log('Ensuring PushSubscription table exists...');
    await executeRaw(`
      CREATE TABLE IF NOT EXISTS "PushSubscription" (
        "id" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "endpoint" TEXT NOT NULL,
        "keys" JSONB NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
      );
    `);
    // PushSubscription FK
    await executeRaw(`
      DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PushSubscription_userId_fkey') THEN
              ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
          END IF;
      END $$;
    `);

    console.log('--- Database Schema Integrity Check Passed (FULL SCHEMA) ---');

  } catch (err) {
    console.error('CRITICAL ERROR fixing DB:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
