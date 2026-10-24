import { describe, it, expect, vi } from 'vitest';

type Note = { isPinned?: boolean; isTrashed?: boolean; isVault?: boolean };
const h = vi.hoisted(() => ({ pred: null as null | ((n: Note) => boolean) }));

vi.mock('dexie-react-hooks', () => ({ useLiveQuery: (fn: () => Promise<unknown>) => { void fn(); return undefined; } }));
vi.mock('../../lib/db', () => ({
  db: {
    notes: {
      filter: (p: (n: Note) => boolean) => {
        h.pred = p;
        return { reverse: () => ({ sortBy: async () => [] }) };
      },
    },
  },
}));

import { usePinnedNotes } from '../usePinnedNotes';

describe('usePinnedNotes', () => {
  it('F.9: una nota vault fissata non entra nei preferiti (il titolo cifrato finirebbe in sidebar)', () => {
    usePinnedNotes();
    const p = h.pred!;
    expect(p({ isPinned: true })).toBe(true);
    expect(p({ isPinned: true, isVault: true })).toBe(false);
    expect(p({ isPinned: true, isTrashed: true })).toBe(false);
    expect(p({ isPinned: false })).toBe(false);
  });
});
