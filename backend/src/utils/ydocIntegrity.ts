/**
 * A TipTap JSON doc is "degenerate" when it has no real text — an empty doc or
 * a single empty paragraph. Used to detect a corrupt ydocState that would render
 * a note blank.
 */
export function isDegenerateTipTapJson(json: unknown): boolean {
  if (!json || typeof json !== 'object') return true;
  const doc = json as { content?: unknown[] };
  if (!Array.isArray(doc.content) || doc.content.length === 0) return true;
  const text = JSON.stringify(doc.content);
  // No "text" leaf anywhere → no actual content.
  return !/"type"\s*:\s*"text"/.test(text);
}
