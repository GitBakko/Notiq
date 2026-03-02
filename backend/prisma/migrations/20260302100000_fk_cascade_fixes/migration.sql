-- TagsOnNotes → Tag: CASCADE
ALTER TABLE "TagsOnNotes" DROP CONSTRAINT "TagsOnNotes_tagId_fkey";
ALTER TABLE "TagsOnNotes" ADD CONSTRAINT "TagsOnNotes_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- KanbanBoard → Note: SET NULL
ALTER TABLE "KanbanBoard" DROP CONSTRAINT "KanbanBoard_noteId_fkey";
ALTER TABLE "KanbanBoard" ADD CONSTRAINT "KanbanBoard_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "Note"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- KanbanCard → Note: SET NULL
ALTER TABLE "KanbanCard" DROP CONSTRAINT "KanbanCard_noteId_fkey";
ALTER TABLE "KanbanCard" ADD CONSTRAINT "KanbanCard_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "Note"("id") ON DELETE SET NULL ON UPDATE CASCADE;
