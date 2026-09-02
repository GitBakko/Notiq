-- Data-only migration: the schema is unchanged.
--
-- WHY THIS EXISTS
--
-- linkNoteToCard and unlinkNoteFromCard persisted the linked note's TITLE into
-- KanbanCardActivity.metadata, and GET /api/kanban/cards/:id/activities served
-- that metadata verbatim to anyone holding READ on the board. The board view has
-- filtered linked-note data per user since the SSE payload was fixed, so the same
-- modal showed "Linked note (no access)" on the face of the card and the note's
-- real title one tab over, in the Activity list. Reproduced over HTTP against a
-- live backend: a board member received {"noteTitle":"..."} here while the notes
-- API answered 404 errors.notes.notFound for that same note.
--
-- The write side now stores only { noteId }, and the read side resolves the title
-- per requesting user through the same predicate getBoard uses (owned, or shared
-- with an ACCEPTED share). This migration removes the titles already written.
-- Without it the fix protects only rows created after the deploy.
--
-- NOTE_LINKED rows keep their noteId, so the read path can still show the real
-- title to everyone entitled to it — nothing is lost for them. NOTE_UNLINKED rows
-- written before the fix carried the title and NO id: for those the title is gone
-- for good, including for the note's owner. That is deliberate. Keeping them was
-- not an option: with no id there is nothing to check access against, so they
-- would have to be blanked on read for everybody anyway — while leaving the
-- plaintext in every pg_dump and in every backup ZIP.
--
-- Idempotent: running it twice changes nothing the second time — the predicate
-- extinguishes itself. Verified on a throwaway database seeded with all four
-- metadata shapes this codebase produces.
--
-- Both guards are load-bearing, and both were confirmed by watching the cheaper
-- version fail with "cannot delete from scalar":
--   * jsonb_typeof(...) = 'object'  — logCardActivity writes Prisma.JsonNull for
--     every activity without metadata, which is jsonb 'null', not SQL NULL. It is
--     the majority shape in this table.
--   * metadata ? 'noteTitle'        — on its own this is NOT enough: on a jsonb
--     string scalar the ? operator tests string equality, not key presence.
UPDATE "KanbanCardActivity"
SET "metadata" = "metadata" - 'noteTitle'
WHERE "action" IN ('NOTE_LINKED', 'NOTE_UNLINKED')
  AND jsonb_typeof("metadata") = 'object'
  AND "metadata" ? 'noteTitle';

-- NOT INCLUDED, deliberately:
--   * No backfill of noteId onto legacy NOTE_UNLINKED rows. The card's noteId was
--     already nulled by the unlink, and a later re-link points somewhere else;
--     ordering against the preceding NOTE_LINKED row is a heuristic, not a
--     recovery, and a wrong id here would resolve to a WRONG title.
--   * No NULLIF(..., '{}') collapse of the emptied rows. They read back as {} and
--     the client handles that identically to null.
