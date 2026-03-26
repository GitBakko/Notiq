-- Phase 1: Cascade User Deletion Safety
-- Makes user deletion safe by adding proper ON DELETE behavior to all User FK relations.
-- No data is modified — only future DELETE behavior changes.

-- ============================================================================
-- 1. Invitation: creatorId → nullable + SET NULL, usedById → SET NULL
-- ============================================================================

-- Make creatorId nullable (was required)
ALTER TABLE "Invitation" ALTER COLUMN "creatorId" DROP NOT NULL;

-- Drop and recreate FK for creatorId with SET NULL
ALTER TABLE "Invitation" DROP CONSTRAINT IF EXISTS "Invitation_creatorId_fkey";
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_creatorId_fkey"
  FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Drop and recreate FK for usedById with SET NULL
ALTER TABLE "Invitation" DROP CONSTRAINT IF EXISTS "Invitation_usedById_fkey";
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_usedById_fkey"
  FOREIGN KEY ("usedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- 2. Notebook: userId → CASCADE (deletes all user's notebooks)
-- ============================================================================

ALTER TABLE "Notebook" DROP CONSTRAINT IF EXISTS "Notebook_userId_fkey";
ALTER TABLE "Notebook" ADD CONSTRAINT "Notebook_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- 3. Note: userId → CASCADE (deletes all user's notes)
-- ============================================================================

ALTER TABLE "Note" DROP CONSTRAINT IF EXISTS "Note_userId_fkey";
ALTER TABLE "Note" ADD CONSTRAINT "Note_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- 4. Tag: userId → CASCADE (deletes all user's tags)
-- ============================================================================

ALTER TABLE "Tag" DROP CONSTRAINT IF EXISTS "Tag_userId_fkey";
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- 5. TaskList: userId → CASCADE (deletes all user's task lists)
-- ============================================================================

ALTER TABLE "TaskList" DROP CONSTRAINT IF EXISTS "TaskList_userId_fkey";
ALTER TABLE "TaskList" ADD CONSTRAINT "TaskList_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add standalone index on TaskList.userId (for direct user lookups)
CREATE INDEX IF NOT EXISTS "TaskList_userId_idx" ON "TaskList"("userId");

-- ============================================================================
-- 6. KanbanBoard: ownerId → CASCADE, noteLinkedById → SET NULL,
--    taskListLinkedById → SET NULL
-- ============================================================================

ALTER TABLE "KanbanBoard" DROP CONSTRAINT IF EXISTS "KanbanBoard_ownerId_fkey";
ALTER TABLE "KanbanBoard" ADD CONSTRAINT "KanbanBoard_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "KanbanBoard" DROP CONSTRAINT IF EXISTS "KanbanBoard_noteLinkedById_fkey";
ALTER TABLE "KanbanBoard" ADD CONSTRAINT "KanbanBoard_noteLinkedById_fkey"
  FOREIGN KEY ("noteLinkedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "KanbanBoard" DROP CONSTRAINT IF EXISTS "KanbanBoard_taskListLinkedById_fkey";
ALTER TABLE "KanbanBoard" ADD CONSTRAINT "KanbanBoard_taskListLinkedById_fkey"
  FOREIGN KEY ("taskListLinkedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- 7. KanbanCard: assigneeId → SET NULL, noteLinkedById → SET NULL
-- ============================================================================

ALTER TABLE "KanbanCard" DROP CONSTRAINT IF EXISTS "KanbanCard_assigneeId_fkey";
ALTER TABLE "KanbanCard" ADD CONSTRAINT "KanbanCard_assigneeId_fkey"
  FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "KanbanCard" DROP CONSTRAINT IF EXISTS "KanbanCard_noteLinkedById_fkey";
ALTER TABLE "KanbanCard" ADD CONSTRAINT "KanbanCard_noteLinkedById_fkey"
  FOREIGN KEY ("noteLinkedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- 8. KanbanComment: authorId → CASCADE (comments useless without author)
-- ============================================================================

ALTER TABLE "KanbanComment" DROP CONSTRAINT IF EXISTS "KanbanComment_authorId_fkey";
ALTER TABLE "KanbanComment" ADD CONSTRAINT "KanbanComment_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- 9. KanbanBoardChat: authorId → CASCADE (chat messages useless without author)
-- ============================================================================

ALTER TABLE "KanbanBoardChat" DROP CONSTRAINT IF EXISTS "KanbanBoardChat_authorId_fkey";
ALTER TABLE "KanbanBoardChat" ADD CONSTRAINT "KanbanBoardChat_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- 10. KanbanCardActivity: userId → nullable + SET NULL (keep activity history)
-- ============================================================================

-- Make userId nullable (was required) — preserves activity log after user deletion
ALTER TABLE "KanbanCardActivity" ALTER COLUMN "userId" DROP NOT NULL;

ALTER TABLE "KanbanCardActivity" DROP CONSTRAINT IF EXISTS "KanbanCardActivity_userId_fkey";
ALTER TABLE "KanbanCardActivity" ADD CONSTRAINT "KanbanCardActivity_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
