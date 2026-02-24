-- AlterTable
ALTER TABLE "KanbanBoard" ADD COLUMN     "avatarUrl" TEXT,
ADD COLUMN     "noteId" TEXT,
ADD COLUMN     "noteLinkedById" TEXT;

-- CreateIndex
CREATE INDEX "KanbanBoard_noteId_idx" ON "KanbanBoard"("noteId");

-- AddForeignKey
ALTER TABLE "KanbanBoard" ADD CONSTRAINT "KanbanBoard_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "Note"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KanbanBoard" ADD CONSTRAINT "KanbanBoard_noteLinkedById_fkey" FOREIGN KEY ("noteLinkedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
