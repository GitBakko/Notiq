import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import toast from 'react-hot-toast';
import VersionHistoryModal from '../VersionHistoryModal';

const restoreNoteVersion = vi.fn();

vi.mock('../noteService', () => ({
  getNoteVersions: () => Promise.resolve([{ id: 'v1', content: '{}', createdAt: '2026-01-01T00:00:00Z' }]),
  restoreNoteVersion: (...a: unknown[]) => restoreNoteVersion(...a),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../hooks/useFocusTrap', () => ({ useFocusTrap: () => undefined }));
vi.mock('../../../components/ui/ConfirmDialog', () => ({
  ConfirmDialog: ({ isOpen, onConfirm }: { isOpen: boolean; onConfirm: () => void }) =>
    isOpen ? <button data-testid="confirm" onClick={onConfirm} /> : null,
}));

async function triggerRestore() {
  render(<VersionHistoryModal noteId="n1" onClose={vi.fn()} onRestored={vi.fn()} />);
  const btn = await screen.findByText('notes.versions.restore');
  fireEvent.click(btn);
  fireEvent.click(await screen.findByTestId('confirm'));
}

describe('VersionHistoryModal restore errors', () => {
  beforeEach(() => vi.clearAllMocks());

  it('422 restoreUnsupportedLive -> specific toast', async () => {
    restoreNoteVersion.mockRejectedValue({ response: { status: 422, data: { message: 'errors.notes.restoreUnsupportedLive' } } });
    await triggerRestore();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('errors.notes.restoreUnsupportedLive'));
  });

  it('other error -> generic toast', async () => {
    restoreNoteVersion.mockRejectedValue({ response: { status: 500, data: { message: 'x' } } });
    await triggerRestore();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('notes.versions.restoreFailed'));
  });
});
