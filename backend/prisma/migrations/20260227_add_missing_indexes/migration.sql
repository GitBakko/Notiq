-- DropIndex
DROP INDEX IF EXISTS "AuditLog_userId_idx";

-- DropIndex
DROP INDEX IF EXISTS "KanbanBoardChat_boardId_idx";

-- CreateIndex
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "GroupMember_userId_idx" ON "GroupMember"("userId");

-- CreateIndex
CREATE INDEX "KanbanBoardChat_boardId_createdAt_idx" ON "KanbanBoardChat"("boardId", "createdAt");

-- CreateIndex
CREATE INDEX "KanbanBoardChat_authorId_idx" ON "KanbanBoardChat"("authorId");
