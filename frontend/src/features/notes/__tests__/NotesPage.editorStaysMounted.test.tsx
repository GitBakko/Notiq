import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// R1: a note created local-first can get a 404 from GET /notes/:id before its POST arrives. A later
// invalidate of notes.detail (e.g. after sharing) must NOT unmount the editor (it would lose its local state).

const h = vi.hoisted(() => ({
  getNote: vi.fn(),
  mounts: 0,
  unmounts: 0,
}));

vi.mock('../noteService', () => ({ createNote: vi.fn(), getNote: (...a: unknown[]) => h.getNote(...a) }));
vi.mock('../../../hooks/useNotes', () => ({
  useNotes: () => [{ id: 'n1', title: 't', content: 'c', userId: 'u1', isVault: false }],
}));
vi.mock('../../../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../../../hooks/useDebounce', () => ({ useDebounce: (v: unknown) => v }));
vi.mock('../../../hooks/useImport', () => ({
  useImport: () => ({ importFile: vi.fn(), isUploading: false, hiddenInput: null, notebookPickerModal: null }),
}));
vi.mock('../../../store/uiStore', () => ({
  useUIStore: () => ({
    toggleSidebar: vi.fn(), notesSortField: 'updatedAt', notesSortOrder: 'desc', setNotesSort: vi.fn(),
    isListCollapsed: true, toggleListCollapsed: vi.fn(), collapseAll: vi.fn(),
  }),
}));
vi.mock('../../../store/authStore', () => ({ useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { id: 'u1' } }) }));
vi.mock('dexie-react-hooks', () => ({ useLiveQuery: () => [] }));
vi.mock('../../../lib/db', () => ({ db: {} }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../NoteList', () => ({ default: () => null }));
vi.mock('../../../components/ui/SortDropdown', () => ({ default: () => null }));
vi.mock('../../../components/ui/Skeleton', () => ({ default: { List: () => null } }));
vi.mock('../../../components/sharing/SharedUsersModal', () => ({ default: () => null }));
vi.mock('../NoteEditor', async () => {
  const React = await import('react');
  function MockEditor() {
    React.useEffect(() => { h.mounts++; return () => { h.unmounts++; }; }, []);
    return React.createElement('div', { 'data-testid': 'editor' });
  }
  return { default: MockEditor };
});

import NotesPage from '../NotesPage';
import { queryKeys } from '../../../lib/queryKeys';

describe('NotesPage editor stays mounted', () => {
  it('404 on GET then invalidate: NoteEditor is not unmounted', async () => {
    h.getNote.mockRejectedValueOnce(new Error('404'));
    h.getNote.mockImplementation(() => new Promise(() => {})); // refetch never settles
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/?noteId=n1']}><NotesPage /></MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('editor')).toBeTruthy());
    await act(async () => { void qc.invalidateQueries({ queryKey: queryKeys.notes.detail('n1') }); await new Promise((r) => setTimeout(r, 50)); });
    expect(screen.queryByTestId('editor')).toBeTruthy();
    expect(h.unmounts).toBe(0);
  });
});
