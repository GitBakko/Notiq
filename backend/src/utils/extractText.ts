/**
 * Extracts plain text from TipTap JSON content.
 * Used by: import service, search indexing, AI context.
 * Skips encryptedBlock nodes (ciphertext is not searchable).
 */
export function extractTextFromTipTapJson(content: string): string {
  if (!content) return '';

  try {
    const json = JSON.parse(content);
    if (typeof json !== 'object' || json === null) return '';
    return extractNodeText(json).replace(/\s+/g, ' ').trim();
  } catch {
    // Fallback: strip HTML tags (legacy content)
    return content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

function extractNodeText(node: any): string {
  if (node.type === 'encryptedBlock') return '';

  if (node.type === 'text' && node.text) {
    return node.text;
  }

  if (node.content && Array.isArray(node.content)) {
    return node.content
      .map((child: any) => extractNodeText(child))
      .filter(Boolean)
      .join(' ');
  }

  return '';
}

/**
 * Counts characters and visual lines from TipTap JSON content.
 * Unlike extractTextFromTipTapJson (which flattens everything for search),
 * this function respects document structure:
 *   - paragraph, heading → 1 line each
 *   - tableRow → 1 line (cells joined by tab)
 *   - listItem / taskItem → 1 line each
 *   - codeBlock → preserves internal newlines (N lines)
 *   - containers (doc, table, lists, blockquote) → join children with newlines
 */
export function countDocumentStats(content: string): { characters: number; lines: number } {
  if (!content) return { characters: 0, lines: 0 };

  try {
    const json = JSON.parse(content);
    if (typeof json !== 'object' || json === null) return { characters: 0, lines: 0 };

    const characters = countChars(json);
    const structuredText = extractStructuredText(json).trim();
    const lines = structuredText ? structuredText.split('\n').length : 0;

    return { characters, lines };
  } catch {
    // Fallback: strip HTML tags (legacy content)
    const stripped = content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return { characters: stripped.length, lines: stripped ? 1 : 0 };
  }
}

/** Counts total text characters across all text nodes (excluding encrypted blocks). */
function countChars(node: any): number {
  if (node.type === 'encryptedBlock') return 0;
  if (node.type === 'text' && node.text) return node.text.length;
  if (node.content && Array.isArray(node.content)) {
    return node.content.reduce((sum: number, c: any) => sum + countChars(c), 0);
  }
  return 0;
}

/** Extracts text preserving line structure with \n between block elements. */
function extractStructuredText(node: any): string {
  if (!node) return '';
  if (node.type === 'encryptedBlock') return '';
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';

  const children = node.content;
  if (!children || !Array.isArray(children) || children.length === 0) return '';

  // Code block: preserve internal newlines as-is
  if (node.type === 'codeBlock') {
    return children.map((c: any) => c.text || '').join('');
  }

  // Table row: cells on one line separated by tab
  if (node.type === 'tableRow') {
    return children
      .map((cell: any) => extractStructuredText(cell).replace(/\n/g, ' '))
      .filter(Boolean)
      .join('\t');
  }

  // Paragraph, heading: inline children joined (one line)
  if (node.type === 'paragraph' || node.type === 'heading') {
    return children.map((c: any) => extractStructuredText(c)).join('');
  }

  // Everything else (doc, table, lists, listItem, blockquote, tableCell, etc.):
  // join child outputs with newline
  return children
    .map((c: any) => extractStructuredText(c))
    .filter(Boolean)
    .join('\n');
}
