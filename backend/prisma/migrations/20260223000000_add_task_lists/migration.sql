-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'TASK_ITEM_ADDED';
ALTER TYPE "NotificationType" ADD VALUE 'TASK_ITEM_CHECKED';
ALTER TYPE "NotificationType" ADD VALUE 'TASK_ITEM_REMOVED';
ALTER TYPE "NotificationType" ADD VALUE 'TASK_LIST_SHARED';

-- CreateTable
CREATE TABLE "TaskList" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isTrashed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "TaskList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskItem" (
    "id" TEXT NOT NULL,
    "taskListId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "isChecked" BOOLEAN NOT NULL DEFAULT false,
    "priority" "TaskPriority" NOT NULL DEFAULT 'MEDIUM',
    "dueDate" TIMESTAMP(3),
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SharedTaskList" (
    "id" TEXT NOT NULL,
    "taskListId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "permission" "Permission" NOT NULL DEFAULT 'READ',
    "status" "ShareStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SharedTaskList_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaskList_userId_isTrashed_idx" ON "TaskList"("userId", "isTrashed");

-- CreateIndex
CREATE INDEX "TaskItem_taskListId_idx" ON "TaskItem"("taskListId");

-- CreateIndex
CREATE UNIQUE INDEX "SharedTaskList_taskListId_userId_key" ON "SharedTaskList"("taskListId", "userId");

-- CreateIndex
CREATE INDEX "SharedTaskList_userId_status_idx" ON "SharedTaskList"("userId", "status");

-- AddForeignKey
ALTER TABLE "TaskList" ADD CONSTRAINT "TaskList_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskItem" ADD CONSTRAINT "TaskItem_taskListId_fkey" FOREIGN KEY ("taskListId") REFERENCES "TaskList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SharedTaskList" ADD CONSTRAINT "SharedTaskList_taskListId_fkey" FOREIGN KEY ("taskListId") REFERENCES "TaskList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SharedTaskList" ADD CONSTRAINT "SharedTaskList_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
