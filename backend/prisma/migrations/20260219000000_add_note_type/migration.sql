-- CreateEnum
CREATE TYPE "NoteType" AS ENUM ('NOTE', 'CREDENTIAL');

-- AlterTable
ALTER TABLE "Note" ADD COLUMN "noteType" "NoteType" NOT NULL DEFAULT 'NOTE';
