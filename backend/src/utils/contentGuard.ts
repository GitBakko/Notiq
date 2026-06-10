/**
 * Empty-overwrite guard. An empty TipTap doc serializes to ~46-93 chars
 * ({"type":"doc","content":[{"type":"paragraph"...}]}). Refuse to overwrite
 * substantial existing content with a near-empty doc — this is the class of
 * write that caused the blank-note data-loss incident (2026-06).
 *
 * @returns the content to persist, or `undefined` when the write must be dropped.
 */
const EMPTY_THRESHOLD = 150;

export function guardEmptyContentOverwrite(
  oldContent: string | null | undefined,
  newContent: string,
): string | undefined {
  const isNewEmpty = newContent.length < EMPTY_THRESHOLD;
  const isOldSubstantial = (oldContent?.length ?? 0) > EMPTY_THRESHOLD;
  if (isNewEmpty && isOldSubstantial) return undefined;
  return newContent;
}
