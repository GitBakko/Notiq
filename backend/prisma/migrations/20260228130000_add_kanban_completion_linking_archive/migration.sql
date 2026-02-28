-- AlterTable: KanbanColumn — add isCompleted flag
ALTER TABLE "KanbanColumn" ADD COLUMN "isCompleted" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: KanbanCard — add archivedAt and taskItemId
ALTER TABLE "KanbanCard" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "KanbanCard" ADD COLUMN "taskItemId" TEXT;

-- AlterTable: KanbanBoard — add taskListId and taskListLinkedById
ALTER TABLE "KanbanBoard" ADD COLUMN "taskListId" TEXT;
ALTER TABLE "KanbanBoard" ADD COLUMN "taskListLinkedById" TEXT;

-- CreateIndex: unique constraint on KanbanBoard.taskListId
CREATE UNIQUE INDEX "KanbanBoard_taskListId_key" ON "KanbanBoard"("taskListId");

-- CreateIndex: unique constraint on KanbanCard.taskItemId
CREATE UNIQUE INDEX "KanbanCard_taskItemId_key" ON "KanbanCard"("taskItemId");

-- AddForeignKey: KanbanBoard.taskListId -> TaskList.id
ALTER TABLE "KanbanBoard" ADD CONSTRAINT "KanbanBoard_taskListId_fkey" FOREIGN KEY ("taskListId") REFERENCES "TaskList"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: KanbanBoard.taskListLinkedById -> User.id
ALTER TABLE "KanbanBoard" ADD CONSTRAINT "KanbanBoard_taskListLinkedById_fkey" FOREIGN KEY ("taskListLinkedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: KanbanCard.taskItemId -> TaskItem.id
ALTER TABLE "KanbanCard" ADD CONSTRAINT "KanbanCard_taskItemId_fkey" FOREIGN KEY ("taskItemId") REFERENCES "TaskItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
