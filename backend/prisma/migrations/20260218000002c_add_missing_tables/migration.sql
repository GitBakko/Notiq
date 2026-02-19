-- AlterTable: Add missing columns to User
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "locale" TEXT NOT NULL DEFAULT 'en';
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable: Add missing columns to Note
ALTER TABLE "Note" ADD COLUMN IF NOT EXISTS "isVault" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Note" ADD COLUMN IF NOT EXISTS "isEncrypted" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: Add missing columns to Tag
ALTER TABLE "Tag" ADD COLUMN IF NOT EXISTS "isVault" BOOLEAN NOT NULL DEFAULT false;

-- DropIndex (if exists) and recreate unique index for Tag
DROP INDEX IF EXISTS "Tag_userId_name_key";
CREATE UNIQUE INDEX IF NOT EXISTS "Tag_userId_name_isVault_key" ON "Tag"("userId", "name", "isVault");

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "SystemSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvitationRequest" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "status" "RequestStatus" NOT NULL DEFAULT 'PENDING',
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvitationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InvitationRequest_email_key" ON "InvitationRequest"("email");

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "Note"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
