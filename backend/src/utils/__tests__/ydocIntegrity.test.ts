import { describe, it, expect } from 'vitest';
import { isDegenerateTipTapJson } from '../ydocIntegrity';

describe('isDegenerateTipTapJson', () => {
  it('flags empty doc', () => {
    expect(isDegenerateTipTapJson({ type: 'doc', content: [] })).toBe(true);
  });
  it('flags single empty paragraph', () => {
    expect(isDegenerateTipTapJson({ type: 'doc', content: [{ type: 'paragraph' }] })).toBe(true);
  });
  it('flags multiple empty paragraphs', () => {
    expect(isDegenerateTipTapJson({ type: 'doc', content: [{ type: 'paragraph' }, { type: 'paragraph', content: [] }] })).toBe(true);
  });
  it('passes a doc with text', () => {
    expect(isDegenerateTipTapJson({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] })).toBe(false);
  });
  it('does NOT flag an image-only doc', () => {
    expect(isDegenerateTipTapJson({ type: 'doc', content: [{ type: 'image', attrs: { src: 'https://example.com/i.png' } }] })).toBe(false);
  });
  it('does NOT flag a table-only doc', () => {
    expect(isDegenerateTipTapJson({ type: 'doc', content: [{ type: 'table', content: [{ type: 'tableRow', content: [] }] }] })).toBe(false);
  });
  it('does NOT flag a horizontal-rule-only doc', () => {
    expect(isDegenerateTipTapJson({ type: 'doc', content: [{ type: 'horizontalRule' }] })).toBe(false);
  });
  it('flags null/garbage', () => {
    expect(isDegenerateTipTapJson(null)).toBe(true);
    expect(isDegenerateTipTapJson('nope')).toBe(true);
  });
});
