-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'VAULT_RECOVERY';

-- CreateEnum
CREATE TYPE "VaultStatus" AS ENUM ('NONE', 'READY', 'RESET_PENDING');
CREATE TYPE "VaultMigrationState" AS ENUM ('NONE', 'IN_PROGRESS', 'DONE');
CREATE TYPE "VaultRequestType" AS ENUM ('RESET', 'RECOVERY');
CREATE TYPE "VaultRequestStatus" AS ENUM ('PENDING_APPROVAL', 'PENDING_CODE', 'WAITING', 'RELEASED', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'REJECTED');

-- CreateTable
CREATE TABLE "VaultKeyring" (
    "userId" TEXT NOT NULL,
    "status" "VaultStatus" NOT NULL DEFAULT 'NONE',
    "epoch" INTEGER NOT NULL DEFAULT 0,
    "rev" INTEGER NOT NULL DEFAULT 0,
    "kdf" TEXT,
    "kdfParams" JSONB,
    "pinSalt" BYTEA,
    "wrappedVkPin" BYTEA,
    "authVerifier" BYTEA,
    "serverShareEnc" BYTEA,
    "pepperKeyId" TEXT,
    "vkSigPub" BYTEA,
    "wrappedVkSigKey" BYTEA,
    "escrowBlob" BYTEA,
    "sealedRootShare" BYTEA,
    "rootKeyId" TEXT,
    "userShareUnderVk" BYTEA,
    "migrationState" "VaultMigrationState" NOT NULL DEFAULT 'NONE',
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "resetScheduledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "VaultKeyring_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE "VaultRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "VaultRequestType" NOT NULL,
    "status" "VaultRequestStatus" NOT NULL,
    "codeHash" TEXT, "codeAHash" TEXT, "codeBHash" TEXT,
    "expiresAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "clientEphPub" BYTEA, "fingerprint" TEXT, "notBefore" TIMESTAMP(3),
    "requestIp" TEXT, "requestUserAgent" TEXT,
    "approvedById" TEXT, "approvedAt" TIMESTAMP(3), "rejectReason" TEXT,
    "releasedById" TEXT, "releasedAt" TIMESTAMP(3), "releaseExpiresAt" TIMESTAMP(3),
    "rootShareForClient" BYTEA, "rootSignature" BYTEA, "reason" TEXT,
    "completedPayloadHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3), "cancelledAt" TIMESTAMP(3), "cancelledBy" TEXT,
    CONSTRAINT "VaultRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VaultRequest_userId_type_status_idx" ON "VaultRequest"("userId", "type", "status");

-- AddForeignKey
ALTER TABLE "VaultKeyring" ADD CONSTRAINT "VaultKeyring_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VaultRequest" ADD CONSTRAINT "VaultRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
