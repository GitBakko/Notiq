-- DropForeignKey
ALTER TABLE "Note" DROP CONSTRAINT "Note_notebookId_fkey";

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_notebookId_fkey" FOREIGN KEY ("notebookId") REFERENCES "Notebook"("id") ON DELETE CASCADE ON UPDATE CASCADE;
