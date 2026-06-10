/**
 * A TipTap JSON doc is "degenerate" when it is structurally blank — an empty doc
 * or a doc whose every node is an empty paragraph. This matches the blank-note
 * data-loss incident (2026-06).
 *
 * IMPORTANT: a doc whose only content is a non-text block (image, table,
 * horizontal rule, code block, etc.) is NOT degenerate — it has real content.
 * Do not treat "no text leaf" as blank, or such notes get blocked from saving.
 */
export function isDegenerateTipTapJson(json: unknown): boolean {
  if (!json || typeof json !== 'object') return true;
  const doc = json as { content?: unknown[] };
  if (!Array.isArray(doc.content) || doc.content.length === 0) return true;

  // Blank only if EVERY top-level node is an empty paragraph. Any non-paragraph
  // block (image/table/hr/codeBlock/...) or any paragraph with children means
  // the doc has real content.
  return doc.content.every((node) => {
    if (!node || typeof node !== 'object') return true;
    const n = node as { type?: string; content?: unknown[] };
    if (n.type !== 'paragraph') return false;
    return !Array.isArray(n.content) || n.content.length === 0;
  });
}
