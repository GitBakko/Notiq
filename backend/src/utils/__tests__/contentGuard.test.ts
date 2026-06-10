import { describe, it, expect } from 'vitest';
import { guardEmptyContentOverwrite, EMPTY_THRESHOLD } from '../contentGuard';

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

// helper: build a content string of an exact length
const ofLength = (n: number) => 'x'.repeat(n);

describe('guardEmptyContentOverwrite — boundary', () => {
  const SUBSTANTIAL_OLD = ofLength(EMPTY_THRESHOLD + 1); // 151, "old substantial"

  it('new length === threshold (150) is NOT empty → write allowed', () => {
    const newC = ofLength(EMPTY_THRESHOLD); // 150, not < 150
    expect(guardEmptyContentOverwrite(SUBSTANTIAL_OLD, newC)).toBe(newC);
  });

  it('new length === threshold-1 (149) IS empty over substantial → dropped', () => {
    const newC = ofLength(EMPTY_THRESHOLD - 1); // 149, < 150
    expect(guardEmptyContentOverwrite(SUBSTANTIAL_OLD, newC)).toBeUndefined();
  });

  it('old length === threshold (150) is NOT substantial → write allowed even if new empty', () => {
    const oldC = ofLength(EMPTY_THRESHOLD);     // 150, not > 150
    const newC = ofLength(EMPTY_THRESHOLD - 1); // 149, empty
    expect(guardEmptyContentOverwrite(oldC, newC)).toBe(newC);
  });

  it('old length === threshold+1 (151) IS substantial → empty new dropped', () => {
    const oldC = ofLength(EMPTY_THRESHOLD + 1); // 151
    const newC = ofLength(EMPTY_THRESHOLD - 1); // 149
    expect(guardEmptyContentOverwrite(oldC, newC)).toBeUndefined();
  });

  it('undefined old content → write allowed', () => {
    expect(guardEmptyContentOverwrite(undefined, ofLength(10))).toBe(ofLength(10));
  });
});
