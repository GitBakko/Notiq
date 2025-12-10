-- AlterTable
ALTER TABLE "User" ADD COLUMN     "surname" TEXT,
ADD COLUMN     "gender" TEXT,
ADD COLUMN     "dateOfBirth" TIMESTAMP(3),
ADD COLUMN     "placeOfBirth" TEXT,
ADD COLUMN     "mobile" TEXT,
ADD COLUMN     "avatarUrl" TEXT,
ADD COLUMN     "resetToken" TEXT,
ADD COLUMN     "resetTokenExpiry" TIMESTAMP(3);
