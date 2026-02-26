-- Fix: Add missing KanbanCard.noteLinkedById column
ALTER TABLE "KanbanCard" ADD COLUMN IF NOT EXISTS "noteLinkedById" TEXT;

-- Fix: Add missing KanbanCard noteId index (was in schema but never migrated)
CREATE INDEX IF NOT EXISTS "KanbanCard_noteId_idx" ON "KanbanCard"("noteId");

-- Fix: Add FK for KanbanCard.noteLinkedById -> User
ALTER TABLE "KanbanCard" DROP CONSTRAINT IF EXISTS "KanbanCard_noteLinkedById_fkey";
ALTER TABLE "KanbanCard" ADD CONSTRAINT "KanbanCard_noteLinkedById_fkey"
  FOREIGN KEY ("noteLinkedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Fix: Create KanbanCardAction enum if missing
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'KanbanCardAction') THEN
    CREATE TYPE "KanbanCardAction" AS ENUM (
      'CREATED', 'MOVED', 'UPDATED', 'ASSIGNED', 'UNASSIGNED',
      'DUE_DATE_SET', 'DUE_DATE_REMOVED', 'NOTE_LINKED', 'NOTE_UNLINKED', 'DELETED'
    );
  END IF;
END $$;

-- Fix: Create KanbanCardActivity table if missing
CREATE TABLE IF NOT EXISTS "KanbanCardActivity" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" "KanbanCardAction" NOT NULL,
    "fromColumnTitle" TEXT,
    "toColumnTitle" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KanbanCardActivity_pkey" PRIMARY KEY ("id")
);

-- Fix: Add indexes for KanbanCardActivity
CREATE INDEX IF NOT EXISTS "KanbanCardActivity_cardId_createdAt_idx"
  ON "KanbanCardActivity"("cardId", "createdAt");

-- Fix: Add FKs for KanbanCardActivity
ALTER TABLE "KanbanCardActivity" DROP CONSTRAINT IF EXISTS "KanbanCardActivity_cardId_fkey";
ALTER TABLE "KanbanCardActivity" ADD CONSTRAINT "KanbanCardActivity_cardId_fkey"
  FOREIGN KEY ("cardId") REFERENCES "KanbanCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "KanbanCardActivity" DROP CONSTRAINT IF EXISTS "KanbanCardActivity_userId_fkey";
ALTER TABLE "KanbanCardActivity" ADD CONSTRAINT "KanbanCardActivity_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
