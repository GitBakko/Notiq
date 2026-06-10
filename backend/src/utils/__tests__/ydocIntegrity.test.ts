import { describe, it, expect } from 'vitest';
import { isDegenerateTipTapJson } from '../ydocIntegrity';

describe('isDegenerateTipTapJson', () => {
  it('flags empty doc', () => {
    expect(isDegenerateTipTapJson({ type: 'doc', content: [] })).toBe(true);
  });
  it('flags single empty paragraph', () => {
    expect(isDegenerateTipTapJson({ type: 'doc', content: [{ type: 'paragraph' }] })).toBe(true);
  });
  it('passes a doc with text', () => {
    expect(isDegenerateTipTapJson({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] })).toBe(false);
  });
  it('flags null/garbage', () => {
    expect(isDegenerateTipTapJson(null)).toBe(true);
    expect(isDegenerateTipTapJson('nope')).toBe(true);
  });
});
