-- CreateEnum
CREATE TYPE "KanbanCardPriority" AS ENUM ('STANDBY', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'KANBAN_CARD_MOVED';
ALTER TYPE "NotificationType" ADD VALUE 'KANBAN_COMMENT_DELETED';

-- AlterTable: User
ALTER TABLE "User" ADD COLUMN "emailNotificationsEnabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable: KanbanCard
ALTER TABLE "KanbanCard" ADD COLUMN "priority" "KanbanCardPriority";
