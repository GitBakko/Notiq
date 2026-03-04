-- Add userId to TagsOnNotes for per-user tag associations on shared notes
ALTER TABLE "TagsOnNotes" ADD COLUMN "userId" TEXT;

-- Backfill: existing tag associations belong to the note owner
UPDATE "TagsOnNotes" t SET "userId" = n."userId"
FROM "Note" n WHERE t."noteId" = n."id";

-- Make non-nullable
ALTER TABLE "TagsOnNotes" ALTER COLUMN "userId" SET NOT NULL;

-- Drop old PK, add new composite PK with userId
ALTER TABLE "TagsOnNotes" DROP CONSTRAINT "TagsOnNotes_pkey";
ALTER TABLE "TagsOnNotes" ADD CONSTRAINT "TagsOnNotes_pkey" PRIMARY KEY ("noteId", "tagId", "userId");

-- Add FK to User
ALTER TABLE "TagsOnNotes" ADD CONSTRAINT "TagsOnNotes_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE;

-- Add recipientNotebookId to SharedNote for per-user notebook assignment
ALTER TABLE "SharedNote" ADD COLUMN "recipientNotebookId" TEXT;

-- Add FK to Notebook (SET NULL on delete)
ALTER TABLE "SharedNote" ADD CONSTRAINT "SharedNote_recipientNotebookId_fkey"
  FOREIGN KEY ("recipientNotebookId") REFERENCES "Notebook"("id") ON DELETE SET NULL;
