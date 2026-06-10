import { describe, it, expect } from 'vitest';
import { guardEmptyContentOverwrite } from '../contentGuard';

const EMPTY_DOC = '{"type":"doc","content":[{"type":"paragraph"}]}'; // ~46 chars
const SUBSTANTIAL = '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"' + 'A'.repeat(200) + '"}]}]}';

describe('guardEmptyContentOverwrite', () => {
  it('returns undefined (drop write) when new is empty and old is substantial', () => {
    expect(guardEmptyContentOverwrite(SUBSTANTIAL, EMPTY_DOC)).toBeUndefined();
  });
  it('allows the write when new content is substantial', () => {
    expect(guardEmptyContentOverwrite(EMPTY_DOC, SUBSTANTIAL)).toBe(SUBSTANTIAL);
  });
  it('allows empty->empty (no real content to protect)', () => {
    expect(guardEmptyContentOverwrite(EMPTY_DOC, EMPTY_DOC)).toBe(EMPTY_DOC);
  });
  it('allows write when old is null/missing', () => {
    expect(guardEmptyContentOverwrite(null, EMPTY_DOC)).toBe(EMPTY_DOC);
  });
});
