-- Add performance indexes for frequently queried FK columns

-- Note: userId + createdAt for time-sorted user note listings
CREATE INDEX "Note_userId_createdAt_idx" ON "Note"("userId", "createdAt");

-- PushSubscription: userId for notification delivery queries
CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription"("userId");

-- InvitationRequest: createdAt for admin listing sorted by date
CREATE INDEX "InvitationRequest_createdAt_idx" ON "InvitationRequest"("createdAt");

-- AiConversation: userId + createdAt for user conversation history
CREATE INDEX "AiConversation_userId_createdAt_idx" ON "AiConversation"("userId", "createdAt");

-- KanbanReminder: dueDate for reminder processing queries
CREATE INDEX "KanbanReminder_dueDate_idx" ON "KanbanReminder"("dueDate");
