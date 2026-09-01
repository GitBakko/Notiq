-- Data-only migration: the schema is unchanged.
--
-- 20260228130000 added "KanbanColumn"."isCompleted" with DEFAULT false and no backfill,
-- so every column that predates it is false. Until 2026-09-01 getBoard repaired that on
-- every read: a board with no completed column got its last one marked. That write was
-- removed because it also undid the user's own change within the same interaction -- the
-- mutation's invalidate refetched through getBoard, which put the flag straight back.
--
-- Without a replacement, any board still in that state stays there forever, and a board
-- with no completed column archives nothing, never ticks its linked task item and never
-- closes a reminder when a card is done. deleteColumn now keeps the invariant on the write
-- path (it promotes a replacement when the completed column is removed); this statement
-- fixes the boards that are already in that state.
--
-- Same rule the read path used, applied once: the column with the highest position wins,
-- id descending as the tiebreaker, matching the ordering used everywhere else since 2.3.
-- Boards that already have a completed column are untouched, and so are boards with no
-- columns at all. Idempotent: running it twice changes nothing the second time.
UPDATE "KanbanColumn"
SET "isCompleted" = true
WHERE "id" IN (
  SELECT DISTINCT ON (c."boardId") c."id"
  FROM "KanbanColumn" c
  WHERE NOT EXISTS (
    SELECT 1 FROM "KanbanColumn" done
    WHERE done."boardId" = c."boardId" AND done."isCompleted" = true
  )
  ORDER BY c."boardId", c."position" DESC, c."id" DESC
);
