-- CreateIndex
CREATE INDEX IF NOT EXISTS "AuditLog_event_createdAt_idx" ON "AuditLog"("event", "createdAt");
