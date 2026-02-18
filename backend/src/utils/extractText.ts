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
