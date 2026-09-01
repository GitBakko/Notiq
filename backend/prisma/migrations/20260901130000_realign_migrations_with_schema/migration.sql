-- Realign the migration history with schema.prisma.
--
-- WHY THIS EXISTS
-- The first CI run of the e2e suite (2026-09-01) failed on its very first request:
--   PrismaClientKnownRequestError: Invalid `prisma.user.findUnique()` invocation
--   The column `(not available)` does not exist in the current database.
-- Every one of the 41 failures was that single error, cascading from the superadmin
-- login in frontend/e2e/helpers.ts.
--
-- The cause was not the specs. A database built from scratch with `prisma migrate deploy`
-- did NOT match schema.prisma: three objects present in dev and prod were never captured
-- in a migration (someone applied them with `prisma db push`), and two foreign keys had
-- the wrong ON DELETE. Nobody noticed locally because the dev database grew by accumulation
-- and already had them.
--
-- That made this more than a CI problem: a disaster-recovery restore onto an empty database,
-- or a `docker compose up` on a clean volume, produced an application that could not even
-- log in.
--
-- IDEMPOTENT BY DESIGN: a no-op on any database that already has these objects (dev, prod).
-- Verified against both a from-scratch database and the dev database before landing.

-- 1. User.color — assigned at registration, used for collaboration awareness and chat.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "color" TEXT;

-- 2. Note.ydocState — the persisted Yjs document state for the collaborative editor.
ALTER TABLE "Note" ADD COLUMN IF NOT EXISTS "ydocState" BYTEA;

-- 3. NotificationType.CHAT_MESSAGE — added with the chat system in v1.9.0.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CHAT_MESSAGE';

-- 4. Four foreign keys whose referential actions drifted from schema.prisma.
--    On a from-scratch database Attachment_noteId_fkey and TagsOnNotes_noteId_fkey are
--    RESTRICT, so deleting a note with an attachment or a tag fails outright.
--    On dev and prod those two are already CASCADE; the only change there is ON UPDATE
--    moving from NO ACTION to CASCADE on two of the four. That is inert in practice --
--    every referenced key is a uuid primary key that is never updated -- and it is what
--    stops `prisma migrate diff` from reporting drift forever after.
ALTER TABLE "Attachment" DROP CONSTRAINT IF EXISTS "Attachment_noteId_fkey";
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_noteId_fkey"
  FOREIGN KEY ("noteId") REFERENCES "Note"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TagsOnNotes" DROP CONSTRAINT IF EXISTS "TagsOnNotes_noteId_fkey";
ALTER TABLE "TagsOnNotes" ADD CONSTRAINT "TagsOnNotes_noteId_fkey"
  FOREIGN KEY ("noteId") REFERENCES "Note"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TagsOnNotes" DROP CONSTRAINT IF EXISTS "TagsOnNotes_userId_fkey";
ALTER TABLE "TagsOnNotes" ADD CONSTRAINT "TagsOnNotes_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SharedNote" DROP CONSTRAINT IF EXISTS "SharedNote_recipientNotebookId_fkey";
ALTER TABLE "SharedNote" ADD CONSTRAINT "SharedNote_recipientNotebookId_fkey"
  FOREIGN KEY ("recipientNotebookId") REFERENCES "Notebook"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- NOT INCLUDED, deliberately: `prisma migrate diff` also wants to drop two indexes.
--   Note_searchVector_idx        -- a GIN index on searchVector, which is
--                                   Unsupported("tsvector") in schema.prisma. Prisma cannot
--                                   model a GIN index on an Unsupported column, so it will
--                                   always ask to drop it. Dropping it would take full-text
--                                   search back to a sequential scan.
--   AiConversation_noteId_userId_idx -- created by 20260218000001; schema.prisma declares
--                                   only @@index([userId, createdAt]). The index is real and
--                                   in use; the schema is what is incomplete.
-- Both are the harmless direction of drift (the database has more than the schema declares),
-- so `migrate diff` will keep listing those two lines and only those two. That is expected.
