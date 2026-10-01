import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';

// v1.13.3: in collab mode the editor starts EMPTY until the provider's first sync.
// Nothing typed before onSynced may reach Dexie / the shared-note REST endpoint.

const h = vi.hoisted(() => {
  const providers: { opts: { onSynced?: () => void } }[] = [];
  class FakeProvider {
    awareness = null;
    isSynced = false;
    isAuthenticated = false;
    opts: { onSynced?: () => void };
    constructor(opts: { onSynced?: () => void }) { this.opts = opts; providers.push(this); }
    on() {}
    off() {}
    destroy() {}
  }
  return {
    providers,
    FakeProvider,
    editor: { onChange: undefined as undefined | ((c: string) => void) },
    updateNoteLocalOnly: vi.fn(),
    saveSharedNoteData: vi.fn(),
  };
});

vi.mock('../useNoteController', () => ({
  useNoteController: () => ({ updateTitle: vi.fn(), updateContent: vi.fn(), saveNote: vi.fn() }),
}));
vi.mock('../noteService', () => ({
  revokeShare: vi.fn(), updateSharedNoteNotebook: vi.fn(),
  updateNoteLocalOnly: (...a: unknown[]) => h.updateNoteLocalOnly(...a),
  saveSharedNoteData: (...a: unknown[]) => h.saveSharedNoteData(...a),
  deleteNote: vi.fn(), permanentlyDeleteNote: vi.fn(),
}));
vi.mock('../../attachments/attachmentService', () => ({ uploadAttachment: vi.fn(), deleteAttachment: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('../../../store/authStore', () => ({
  useAuthStore: Object.assign(() => ({ user: { id: 'u1' } }), { getState: () => ({ token: 't' }) }),
}));
vi.mock('../../../hooks/useNotebooks', () => ({ useNotebooks: () => ({ notebooks: [] }) }));
vi.mock('../../../hooks/useAiStatus', () => ({ useAiStatus: () => ({ isAiEnabled: false }) }));
vi.mock('../../../components/ui/ConfirmDialog', () => ({ ConfirmDialog: () => null }));
vi.mock('@hocuspocus/provider', () => ({ HocuspocusProvider: h.FakeProvider }));
// The Editor mock captures onChange so the test can "type"
vi.mock('../../../components/editor/Editor', () => ({
  default: (props: { onChange?: (c: string) => void }) => { h.editor.onChange = props.onChange; return null; },
}));
vi.mock('../../../components/editor/TagSelector', () => ({ default: () => null }));
vi.mock('../../../components/sharing/SharingModal', () => ({ default: () => null }));
vi.mock('../AttachmentSidebar', () => ({ default: () => null }));
vi.mock('../../../components/editor/ChatSidebar', () => ({ default: () => null }));
vi.mock('../../../components/editor/AiSidebar', () => ({ default: () => null }));
vi.mock('../../../components/editor/NotebookSelector', () => ({ default: () => null }));
vi.mock('../NoteSizeModal', () => ({ default: () => null }));
vi.mock('../VersionHistoryModal', () => ({ default: () => null }));
vi.mock('../../../components/editor/ScrollToEditButton', () => ({ default: () => null }));
vi.mock('../../kanban/components/KanbanBoardLink', () => ({ default: () => null }));

import NoteEditor from '../NoteEditor';

const EMPTY = '{"type":"doc","content":[]}';
// Owned note that is shared with someone => the collab provider connects
const mkNote = (over: object = {}) => ({
  id: 'n1', userId: 'u1', title: 't', content: EMPTY, isVault: false, isPublic: false,
  tags: [], attachments: [], sharedWith: [{ userId: 'u2', permission: 'WRITE' }], ...over,
}) as never;

/** Type into the (mocked) editor and let the 1s content debounce fire. */
const type = (content: string) => {
  act(() => { h.editor.onChange?.(content); });
  act(() => { vi.advanceTimersByTime(1100); });
};

describe('NoteEditor collab pre-sync guard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.providers.length = 0;
    h.editor.onChange = undefined;
    h.updateNoteLocalOnly.mockReset();
    h.saveSharedNoteData.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('persists nothing typed before the first onSynced', () => {
    render(<NoteEditor note={mkNote()} />);
    expect(h.providers).toHaveLength(1);

    type('{"type":"doc","content":[{"type":"paragraph"}]}');

    expect(h.updateNoteLocalOnly).not.toHaveBeenCalled();
    expect(h.saveSharedNoteData).not.toHaveBeenCalled();
  });

  it('recipient (shared, WRITE) typing before the first onSynced never hits saveSharedNoteData', () => {
    render(<NoteEditor note={mkNote({ userId: 'u2', ownership: 'shared', sharedPermission: 'WRITE', sharedWith: [] })} />);
    expect(h.providers).toHaveLength(1);
    expect(h.providers[0]).toMatchObject({ isSynced: false });

    type('{"type":"doc","content":[{"type":"paragraph"}]}');

    expect(h.saveSharedNoteData).not.toHaveBeenCalled();
    expect(h.updateNoteLocalOnly).not.toHaveBeenCalled();
  });

  it('persists again once the provider has synced', () => {
    render(<NoteEditor note={mkNote()} />);
    act(() => { h.providers[0].opts.onSynced?.(); });

    const after = '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"x"}]}]}';
    type(after);

    expect(h.updateNoteLocalOnly).toHaveBeenCalledWith('n1', { content: after });
  });

  describe('J4: recipient save refused with 503 archiveBusy', () => {
    const busy = () => Object.assign(new Error('busy'), { response: { status: 503, data: { message: 'errors.notes.archiveBusy' } } });
    const recipient = () => mkNote({ userId: 'u2', ownership: 'shared', sharedPermission: 'WRITE', sharedWith: [] });
    const text = (x: string) => `{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"${x}"}]}]}`;
    // not authenticated => Hocuspocus does not own persistence => REST fallback path is used
    const syncedAndTyped = async (c: string) => {
      act(() => { h.providers[0].opts.onSynced?.(); });
      type(c);
      await act(async () => { await Promise.resolve(); });
    };

    it('shows the archiveBusy toast (not sharedSaveFailed) and retries ONCE after 2 minutes with the latest content', async () => {
      const toast = (await import('react-hot-toast')).default as unknown as { error: ReturnType<typeof vi.fn> };
      toast.error.mockClear();
      h.saveSharedNoteData.mockReset().mockRejectedValueOnce(busy()).mockResolvedValue(undefined);
      render(<NoteEditor note={recipient()} />);

      await syncedAndTyped(text('a'));
      expect(h.saveSharedNoteData).toHaveBeenCalledTimes(1);
      expect(toast.error).toHaveBeenCalledWith('errors.notes.archiveBusy', { id: 'archive-busy-n1' });
      expect(toast.error).not.toHaveBeenCalledWith('sync.sharedSaveFailed', expect.anything());

      // keep typing, no further failure
      act(() => { h.editor.onChange?.(text('b')); });
      await act(async () => { vi.advanceTimersByTime(119_000); });
      const before = h.saveSharedNoteData.mock.calls.length;
      await act(async () => { vi.advanceTimersByTime(2_000); });
      expect(h.saveSharedNoteData.mock.calls.length).toBeGreaterThan(before);
      expect(h.saveSharedNoteData).toHaveBeenLastCalledWith('n1', { content: text('b') });
    });

    // K4: the retry reads the CURRENT provider (ref), not the one captured when the timer was armed.
    it('provider created after the 503: the retry does no REST (new provider has not synced yet)', async () => {
      h.saveSharedNoteData.mockReset().mockRejectedValueOnce(busy()).mockResolvedValue(undefined);
      // vault => no collab provider at 503 time
      const { rerender } = render(<NoteEditor note={mkNote({ userId: 'u2', ownership: 'shared', sharedPermission: 'WRITE', sharedWith: [], isVault: true })} />);
      expect(h.providers).toHaveLength(0);
      type(text('a'));
      await act(async () => { await Promise.resolve(); });
      expect(h.saveSharedNoteData).toHaveBeenCalledTimes(1);

      rerender(<NoteEditor note={mkNote({ userId: 'u2', ownership: 'shared', sharedPermission: 'WRITE', sharedWith: [], isVault: false })} />);
      expect(h.providers).toHaveLength(1);
      h.saveSharedNoteData.mockClear();

      await act(async () => { vi.advanceTimersByTime(130_000); });
      expect(h.saveSharedNoteData).not.toHaveBeenCalled();
    });

    it('unmount clears the pending retry', async () => {
      h.saveSharedNoteData.mockReset().mockRejectedValueOnce(busy()).mockResolvedValue(undefined);
      const { unmount } = render(<NoteEditor note={recipient()} />);
      await syncedAndTyped(text('a'));
      unmount();
      await act(async () => { vi.advanceTimersByTime(130_000); });
      expect(h.saveSharedNoteData).toHaveBeenCalledTimes(1);
    });
  });

  it('a new note.id gets a new provider and is guarded again', () => {
    const { rerender } = render(<NoteEditor note={mkNote()} />);
    act(() => { h.providers[0].opts.onSynced?.(); });

    rerender(<NoteEditor note={mkNote({ id: 'n2' })} />);
    expect(h.providers).toHaveLength(2);
    h.updateNoteLocalOnly.mockClear();

    type('{"type":"doc","content":[{"type":"paragraph"}]}');

    expect(h.updateNoteLocalOnly).not.toHaveBeenCalled();
    expect(h.saveSharedNoteData).not.toHaveBeenCalled();
  });
});
