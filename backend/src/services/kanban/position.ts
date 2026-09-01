/**
 * Pure ordering helper for a kanban column.
 *
 * Given the current order of a column (card ids, position-ascending) it returns
 * the order after `cardId` has been placed at `newIndex`. The card is removed
 * first and re-inserted — exactly what @dnd-kit's `arrayMove` does on the
 * client — so the server and the board agree on what "index 2" means.
 *
 * - `cardId` may be absent from `cardIds` (cross-column insert): it is added.
 * - `newIndex` is clamped into [0, length], so a sentinel like 999 appends
 *   instead of writing an out-of-range position into the database. A
 *   negative index clamps to the front for the same reason.
 *
 * The returned array IS the new position mapping: index i → position i.
 */
export function computeColumnOrder(
  cardIds: string[],
  cardId: string,
  newIndex: number
): string[] {
  const rest = cardIds.filter((id) => id !== cardId);
  const index = Math.min(Math.max(newIndex, 0), rest.length);
  rest.splice(index, 0, cardId);
  return rest;
}
