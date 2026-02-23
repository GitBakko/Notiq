-- AlterTable: Add coverImage to KanbanBoard
ALTER TABLE "KanbanBoard" ADD COLUMN "coverImage" TEXT;

-- CreateTable: KanbanBoardChat
CREATE TABLE "KanbanBoardChat" (
    "id" TEXT NOT NULL,
    "boardId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KanbanBoardChat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KanbanBoardChat_boardId_idx" ON "KanbanBoardChat"("boardId");

-- AddForeignKey
ALTER TABLE "KanbanBoardChat" ADD CONSTRAINT "KanbanBoardChat_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "KanbanBoard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KanbanBoardChat" ADD CONSTRAINT "KanbanBoardChat_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
