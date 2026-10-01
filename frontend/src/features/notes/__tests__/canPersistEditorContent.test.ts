import { describe, it, expect } from 'vitest';
import { canPersistEditorContent } from '../canPersistEditorContent';

describe('canPersistEditorContent', () => {
  it('no provider -> persist', () => {
    expect(canPersistEditorContent({ hasProvider: false, hasSyncedOnce: false })).toBe(true);
  });
  it('provider never synced -> skip', () => {
    expect(canPersistEditorContent({ hasProvider: true, hasSyncedOnce: false })).toBe(false);
  });
  it('provider synced at least once -> persist', () => {
    expect(canPersistEditorContent({ hasProvider: true, hasSyncedOnce: true })).toBe(true);
  });
});
