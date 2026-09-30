import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const saveNote = vi.fn();
const revokeShare = vi.fn();

vi.mock('../useNoteController', () => ({
  useNoteController: () => ({ updateTitle: vi.fn(), updateContent: vi.fn(), saveNote }),
}));
vi.mock('../noteService', () => ({
  revokeShare: (...a: unknown[]) => revokeShare(...a),
  updateNoteLocalOnly: vi.fn(), updateSharedNoteNotebook: vi.fn(), saveSharedNoteData: vi.fn(),
  deleteNote: vi.fn(), permanentlyDeleteNote: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('../../../store/authStore', () => ({
  useAuthStore: Object.assign(() => ({ user: { id: 'u1' } }), { getState: () => ({ token: 't' }) }),
}));
vi.mock('../../../hooks/useNotebooks', () => ({ useNotebooks: () => ({ notebooks: [] }) }));
vi.mock('../../../hooks/useAiStatus', () => ({ useAiStatus: () => ({ isAiEnabled: false }) }));
vi.mock('../../../components/ui/ConfirmDialog', () => ({
  ConfirmDialog: ({ isOpen, onConfirm }: { isOpen: boolean; onConfirm: () => void }) =>
    isOpen ? <button data-testid="vault-confirm" onClick={onConfirm} /> : null,
}));
vi.mock('@hocuspocus/provider', () => ({ HocuspocusProvider: vi.fn() }));
// Heavy children: irrelevant to the save payload
vi.mock('../../../components/editor/Editor', () => ({ default: () => null }));
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

const mkNote = (over: object = {}) => ({
  id: 'n1', userId: 'u1', title: 't', content: '{"type":"doc","content":[]}', isVault: false, isPublic: false,
  tags: [], attachments: [], ...over,
}) as never;

const lockButton = () => screen.getAllByTitle('notes.addToVault')[0];

describe('NoteEditor move to vault', () => {
  beforeEach(() => { saveNote.mockReset(); saveNote.mockResolvedValue(undefined); revokeShare.mockReset(); });

  it('toggle sends only { isVault: true } (no content key)', () => {
    render(<NoteEditor note={mkNote()} />);
    fireEvent.click(lockButton());
    expect(saveNote).toHaveBeenCalledTimes(1);
    const payload = saveNote.mock.calls[0][0];
    expect(payload).toEqual({ isVault: true });
    expect('content' in payload).toBe(false);
  });

  it('confirm flow (shared/public note) sends no content key either', async () => {
    render(<NoteEditor note={mkNote({ isPublic: true })} />);
    fireEvent.click(lockButton());
    fireEvent.click(await screen.findByTestId('vault-confirm'));
    await waitFor(() => expect(saveNote).toHaveBeenCalledTimes(1));
    const payload = saveNote.mock.calls[0][0];
    expect(payload).toEqual({ isVault: true, isPublic: false });
    expect('content' in payload).toBe(false);
  });
});
