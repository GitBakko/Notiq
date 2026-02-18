-- CreateIndex
CREATE INDEX IF NOT EXISTS "Note_userId_isTrashed_idx" ON "Note"("userId", "isTrashed");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Note_notebookId_idx" ON "Note"("notebookId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Attachment_noteId_isLatest_idx" ON "Attachment"("noteId", "isLatest");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SharedNote_userId_status_idx" ON "SharedNote"("userId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SharedNotebook_userId_status_idx" ON "SharedNotebook"("userId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Notification_userId_isRead_idx" ON "Notification"("userId", "isRead");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ChatMessage_noteId_idx" ON "ChatMessage"("noteId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AuditLog_userId_idx" ON "AuditLog"("userId");
