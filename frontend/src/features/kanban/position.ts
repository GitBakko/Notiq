/**
 * Pure ordering helper for a kanban column.
 *
 * DUPLICATE of backend/src/services/kanban/position.ts. frontend/ and backend/
 * are separate npm workspaces with no shared package and no cross-workspace
 * tsconfig path, so these ten dependency-free lines are copied rather than
 * extracted: a shared workspace would cost a build step and a version
 * constraint for less code than it carries. The table test in
 * __tests__/position.test.ts is copied along with it — if one side ever
 * changes, the other side's table still documents the divergence.
 *
 * Given the current order of a column (card ids, position-ascending) it returns
 * the order after `cardId` has been placed at `newIndex`. The card is removed
 * first and re-inserted — exactly what @dnd-kit's `arrayMove` does — so client
 * and server agree on what "index 2" means.
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
