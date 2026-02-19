-- CreateEnum
CREATE TYPE "ShareStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED');

-- AlterTable
ALTER TABLE "SharedNote" ADD COLUMN "status" "ShareStatus" NOT NULL DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE "SharedNotebook" ADD COLUMN "status" "ShareStatus" NOT NULL DEFAULT 'PENDING';
