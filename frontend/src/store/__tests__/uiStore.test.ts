import { describe, it, expect, beforeEach, vi } from 'vitest';

// uiStore calls window.matchMedia at import time (applyThemeClass with theme 'system').
const media = vi.hoisted(() => ({ matches: false, listener: null as null | ((e: { matches: boolean }) => void) }));
vi.hoisted(() => {
  window.matchMedia = ((query: string) => ({
    get matches() { return media.matches; },
    media: query,
    onchange: null,
    addEventListener: (_type: string, cb: (e: { matches: boolean }) => void) => { media.listener = cb; },
    removeEventListener: () => { media.listener = null; },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

import { useUIStore } from '../uiStore';
import type { KanbanFilters } from '../../features/kanban/components/KanbanFilterBar';

// Mirrors defaultKanbanFilters, inlined so the store test does not pull a React component
// (and lucide + date-fns) into its module graph.
const base: KanbanFilters = { search: '', assigneeIds: [], dueDate: 'all', hasNote: 'all', hasComments: 'all' };

// 6.2 — kanban filters lived in component state: leaving the board (or reloading) threw
// them away. They are now persisted per board in the ui store.
describe('uiStore — kanban filter persistence', () => {
  beforeEach(() => {
    useUIStore.setState({ kanbanFilters: {} });
  });

  it('starts with no stored filters', () => {
    expect(useUIStore.getState().kanbanFilters).toEqual({});
  });

  it('stores filters per board id', () => {
    useUIStore.getState().setKanbanFilters('board-1', { ...base, search: 'invoice' });
    useUIStore.getState().setKanbanFilters('board-2', { ...base, dueDate: 'overdue' });

    const stored = useUIStore.getState().kanbanFilters;
    expect(stored['board-1'].search).toBe('invoice');
    expect(stored['board-2'].dueDate).toBe('overdue');
    expect(stored['board-1'].dueDate).toBe('all');
  });

  it('overwrites the entry for the same board instead of appending', () => {
    useUIStore.getState().setKanbanFilters('board-1', { ...base, search: 'a' });
    useUIStore.getState().setKanbanFilters('board-1', { ...base, search: 'b' });

    expect(Object.keys(useUIStore.getState().kanbanFilters)).toHaveLength(1);
    expect(useUIStore.getState().kanbanFilters['board-1'].search).toBe('b');
  });

  it('drops the whole map once it exceeds 20 boards, keeping only the newest entry', () => {
    for (let i = 0; i < 20; i++) {
      useUIStore.getState().setKanbanFilters(`board-${i}`, { ...base, search: String(i) });
    }
    expect(Object.keys(useUIStore.getState().kanbanFilters)).toHaveLength(20);

    useUIStore.getState().setKanbanFilters('board-20', { ...base, search: '20' });

    expect(Object.keys(useUIStore.getState().kanbanFilters)).toEqual(['board-20']);
  });

  it('still updates a board that is already stored when the map is full', () => {
    for (let i = 0; i < 20; i++) {
      useUIStore.getState().setKanbanFilters(`board-${i}`, { ...base, search: String(i) });
    }
    useUIStore.getState().setKanbanFilters('board-5', { ...base, search: 'changed' });

    const stored = useUIStore.getState().kanbanFilters;
    expect(Object.keys(stored)).toHaveLength(20);
    expect(stored['board-5'].search).toBe('changed');
  });

  it('persists kanbanFilters into localStorage under ui-storage', () => {
    useUIStore.getState().setKanbanFilters('board-1', { ...base, search: 'persisted' });

    const raw = localStorage.getItem('ui-storage');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string).state.kanbanFilters['board-1'].search).toBe('persisted');
  });
});

describe('uiStore — system theme media changes', () => {
  beforeEach(() => {
    media.matches = false;
    document.documentElement.className = 'light';
  });

  it('follows dark/light OS changes only in system theme', () => {
    useUIStore.getState().setTheme('system');
    expect(media.listener).not.toBeNull();
    media.matches = true;
    media.listener!({ matches: true });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    media.matches = false;
    media.listener!({ matches: false });
    expect(document.documentElement.classList.contains('light')).toBe(true);
  });

  it('does not change an explicit light theme when the OS changes', () => {
    useUIStore.getState().setTheme('light');
    media.matches = true;
    media.listener!({ matches: true });
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
