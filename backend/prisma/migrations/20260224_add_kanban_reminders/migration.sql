-- CreateTable
CREATE TABLE "KanbanReminder" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "boardId" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "isDone" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KanbanReminder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KanbanReminder_userId_isDone_idx" ON "KanbanReminder"("userId", "isDone");

-- CreateIndex
CREATE INDEX "KanbanReminder_boardId_idx" ON "KanbanReminder"("boardId");

-- CreateIndex
CREATE UNIQUE INDEX "KanbanReminder_cardId_userId_key" ON "KanbanReminder"("cardId", "userId");

-- AddForeignKey
ALTER TABLE "KanbanReminder" ADD CONSTRAINT "KanbanReminder_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "KanbanCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KanbanReminder" ADD CONSTRAINT "KanbanReminder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KanbanReminder" ADD CONSTRAINT "KanbanReminder_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "KanbanBoard"("id") ON DELETE CASCADE ON UPDATE CASCADE;
