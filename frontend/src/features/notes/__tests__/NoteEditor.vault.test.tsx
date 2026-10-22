import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// Vault v3 (T21, plan 5.9): l'ingresso nel vault e' una chiamata diretta (lib/vaultMove.moveIn), non saveNote/syncQueue.

const { order, moving, listeners, updateNote, saveNote, updateContent, updateTitle, updateNoteLocalOnly, invalidateQueries, revokeShare, moveIn, vaultEntryState, syncPush, toastError, toastSuccess, MoveErr } = vi.hoisted(() => {
  class MoveErr extends Error {
    code: string;
    constructor(code: string) { super(code); this.code = code; }
  }
  return {
    order: [] as string[],
    moving: new Set<string>(), listeners: new Set<() => void>(), updateNote: vi.fn(),
    saveNote: vi.fn(), updateContent: vi.fn(), updateTitle: vi.fn(), updateNoteLocalOnly: vi.fn(), invalidateQueries: vi.fn(), revokeShare: vi.fn(),
    moveIn: vi.fn(), vaultEntryState: vi.fn(), syncPush: vi.fn(),
    toastError: vi.fn(), toastSuccess: vi.fn(), MoveErr,
  };
});

vi.mock('../useNoteController', () => ({
  useNoteController: () => ({ updateTitle, updateContent, saveNote }),
}));
vi.mock('../noteService', () => ({
  updateNote: (...a: unknown[]) => updateNote(...a),
  revokeShare: (...a: unknown[]) => revokeShare(...a),
  updateNoteLocalOnly: (...a: unknown[]) => updateNoteLocalOnly(...a), updateSharedNoteNotebook: vi.fn(), saveSharedNoteData: vi.fn(),
  deleteNote: vi.fn(), permanentlyDeleteNote: vi.fn(),
}));
vi.mock('../../../lib/vaultMove', () => ({
  moveIn: (...a: unknown[]) => moveIn(...a),
  // stato di spostamento di modulo (come lib/vaultMove, che ha i suoi test)
  isMovingIn: (id: string) => moving.has(id),
  subscribeMovingIn: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
  beginMovingIn: (id: string) => { moving.add(id); listeners.forEach((l) => l()); return () => { moving.delete(id); listeners.forEach((l) => l()); }; },
  vaultEntryState: (...a: unknown[]) => vaultEntryState(...a),
  VaultMoveError: MoveErr,
}));
vi.mock('../../sync/syncService', () => ({ syncPush: () => syncPush() }));
vi.mock('../../../components/vault/VaultUnlockDialog', () => ({
  default: ({ isOpen, onUnlocked }: { isOpen: boolean; onUnlocked: () => void }) =>
    isOpen ? <button data-testid="unlock-dialog" onClick={onUnlocked} /> : null,
}));
vi.mock('react-router-dom', () => ({ Navigate: ({ to }: { to: string }) => <div data-testid="navigate" data-to={to} /> }));
vi.mock('../../attachments/attachmentService', () => ({ uploadAttachment: vi.fn(), deleteAttachment: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('react-hot-toast', () => ({ default: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) } }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: (...a: unknown[]) => invalidateQueries(...a) }) }));
vi.mock('../../../store/authStore', () => ({
  useAuthStore: Object.assign(() => ({ user: { id: 'u1' } }), { getState: () => ({ token: 't' }) }),
}));
vi.mock('../../../hooks/useNotebooks', () => ({ useNotebooks: () => ({ notebooks: [] }) }));
vi.mock('../../../hooks/useAiStatus', () => ({ useAiStatus: () => ({ isAiEnabled: false }) }));
vi.mock('../../../components/ui/ConfirmDialog', () => ({
  ConfirmDialog: ({ isOpen, onConfirm, title }: { isOpen: boolean; onConfirm: () => void; title: string }) =>
    isOpen && title === 'vault.warningTitle' ? <button data-testid="vault-confirm" onClick={onConfirm} /> : null,
}));
vi.mock('@hocuspocus/provider', () => ({
  HocuspocusProvider: class { awareness = null; isSynced = false; isAuthenticated = false; on() {} off() {} destroy() {} },
}));
// Editor finto: un click "digita" nel corpo
vi.mock('../../../components/editor/Editor', () => ({
  default: ({ onChange, editable }: { onChange?: (c: string) => void; editable?: boolean }) =>
    <button data-testid="type" data-editable={String(editable)} onClick={() => onChange?.('{"type":"doc","content":[{"typed":"just now"}]}')} />,
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
import { queryKeys } from '../../../lib/queryKeys';

const mkNote = (over: object = {}) => ({
  id: 'n1', userId: 'u1', title: 't', content: '{"type":"doc","content":[]}', isVault: false, isPublic: false,
  tags: [], attachments: [], ...over,
}) as never;

const lockButton = () => screen.getAllByTitle('notes.addToVault')[0];
const setOnline = (v: boolean) => Object.defineProperty(navigator, 'onLine', { value: v, configurable: true });

describe('NoteEditor move to vault (T21)', () => {
  beforeEach(() => {
    order.length = 0;
    moving.clear();
    for (const m of [updateNote, saveNote, updateContent, updateTitle, updateNoteLocalOnly, invalidateQueries, revokeShare, moveIn, vaultEntryState, syncPush, toastError, toastSuccess]) m.mockReset();
    saveNote.mockImplementation(async () => { order.push('saveNote'); });
    updateNote.mockImplementation(async () => { order.push('updateNote'); });
    syncPush.mockImplementation(async () => { order.push('syncPush'); return true; });
    moveIn.mockImplementation(async () => { order.push('moveIn'); });
    vaultEntryState.mockResolvedValue('ready');
    setOnline(true);
  });

  it('keyring pronto: chiama moveIn e MAI saveNote({isVault}) (niente PUT in chiaro via syncQueue)', async () => {
    render(<NoteEditor note={mkNote()} />);
    fireEvent.click(lockButton());
    await waitFor(() => expect(moveIn).toHaveBeenCalledTimes(1));
    expect(moveIn.mock.calls[0][0]).toBe('n1');
    expect(updateNote).not.toHaveBeenCalled(); // nessun testo digitato: niente flush, e niente isVault
    expect(saveNote).not.toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledWith('notes.addedToVault');
  });

  it('testo digitato meno di 1 s prima: flush e syncPush PRIMA di moveIn, nessun updateContent dopo il 200', async () => {
    const onBack = vi.fn(() => order.push('onBack'));
    moveIn.mockImplementation(async (_id: string, args: { onCommitted?: () => void }) => { order.push('moveIn'); args.onCommitted?.(); });
    render(<NoteEditor note={mkNote()} onBack={onBack} />);
    fireEvent.click(screen.getByTestId('type')); // debounce di 1 s ancora in corso
    fireEvent.click(lockButton());
    await waitFor(() => expect(moveIn).toHaveBeenCalledTimes(1));
    expect(updateNote).toHaveBeenCalledWith('n1', { content: '{"type":"doc","content":[{"typed":"just now"}]}' });
    expect(order).toEqual(['updateNote', 'syncPush', 'moveIn', 'onBack']);
    // il debounce "finto": scaduto il secondo, gli effetti non devono scrivere il plaintext
    await new Promise((r) => setTimeout(r, 1300));
    expect(updateContent).not.toHaveBeenCalled();
    expect(updateTitle).not.toHaveBeenCalled();
    expect(updateNote).toHaveBeenCalledTimes(1);
    expect(saveNote).not.toHaveBeenCalled();
  });

  it('onCommitted chiude l editor (onBack) e invalida la query: e quello che moveIn chiama prima di Dexie', async () => {
    const onBack = vi.fn();
    moveIn.mockImplementation(async (_id: string, args: { onCommitted?: () => void }) => { args.onCommitted?.(); });
    render(<NoteEditor note={mkNote()} onBack={onBack} />);
    fireEvent.click(lockButton());
    await waitFor(() => expect(onBack).toHaveBeenCalledTimes(1));
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.notes.detail('n1') });
  });

  it('keyring NONE / UNKNOWN: navigazione a /vault, nessuna PUT, nessun salvataggio', async () => {
    vaultEntryState.mockResolvedValue('setup');
    render(<NoteEditor note={mkNote()} />);
    fireEvent.click(lockButton());
    expect((await screen.findByTestId('navigate')).getAttribute('data-to')).toBe('/vault');
    expect(moveIn).not.toHaveBeenCalled();
    expect(updateNote).not.toHaveBeenCalled();
  });

  it('keyring NONE con testo appena digitato: flush PRIMA della navigazione a /vault', async () => {
    vaultEntryState.mockResolvedValue('setup');
    render(<NoteEditor note={mkNote()} />);
    fireEvent.click(screen.getByTestId('type'));
    fireEvent.click(lockButton());
    await screen.findByTestId('navigate');
    expect(updateNote).toHaveBeenCalledWith('n1', { content: '{"type":"doc","content":[{"typed":"just now"}]}' });
    expect(moveIn).not.toHaveBeenCalled();
  });

  it('keyring bloccato: dialog del PIN, e dopo lo sblocco parte moveIn', async () => {
    vaultEntryState.mockResolvedValue('locked');
    render(<NoteEditor note={mkNote()} />);
    fireEvent.click(lockButton());
    fireEvent.click(await screen.findByTestId('unlock-dialog'));
    await waitFor(() => expect(moveIn).toHaveBeenCalledTimes(1));
  });

  it('offline: il comando e disabilitato', () => {
    setOnline(false);
    render(<NoteEditor note={mkNote()} />);
    const btn = screen.getAllByTitle('vault.moveIn.offline')[0] as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(vaultEntryState).not.toHaveBeenCalled();
    expect(moveIn).not.toHaveBeenCalled();
  });

  it('allegati: bloccato col messaggio, nessuna chiamata', async () => {
    render(<NoteEditor note={mkNote({ attachments: [{ id: 'a1', size: 10, url: '/u' }] })} />);
    fireEvent.click(lockButton());
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('errors.vault.attachmentsBlocked'));
    expect(vaultEntryState).not.toHaveBeenCalled();
    expect(moveIn).not.toHaveBeenCalled();
  });

  it('nota condivisa/pubblica: conferma, poi moveIn con beforePut che revoca le condivisioni', async () => {
    render(<NoteEditor note={mkNote({ isPublic: true, sharedWith: [{ id: 's1', userId: 'u2', permission: 'READ', status: 'ACCEPTED', user: { id: 'u2', name: 'U2', email: 'u2@x.it' } }] })} />);
    fireEvent.click(lockButton());
    expect(moveIn).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId('vault-confirm'));
    await waitFor(() => expect(moveIn).toHaveBeenCalledTimes(1));
    expect(revokeShare).not.toHaveBeenCalled(); // la revoca e dentro moveIn, subito prima della PUT
    await moveIn.mock.calls[0][1].beforePut();
    expect(revokeShare).toHaveBeenCalledWith('n1', 'u2');
  });

  it('errore di moveIn: messaggio per codice e l editor torna a salvare', async () => {
    moveIn.mockRejectedValueOnce(new MoveErr('conflict'));
    render(<NoteEditor note={mkNote()} />);
    fireEvent.click(lockButton());
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('vault.moveIn.conflict'));
    // secondo tentativo possibile: movingRef e tornato false
    fireEvent.click(lockButton());
    await waitFor(() => expect(moveIn).toHaveBeenCalledTimes(2));
  });

  it('nota condivisa dal proprietario (provider presente), titolo cambiato subito prima: updateNote({title}) PRIMA di syncPush', async () => {
    const shared = [{ id: 's1', userId: 'u2', permission: 'READ', status: 'ACCEPTED', user: { id: 'u2', name: 'U2', email: 'u2@x.it' } }];
    render(<NoteEditor note={mkNote({ sharedWith: shared })} />);
    fireEvent.change(screen.getByPlaceholderText('notes.titlePlaceholder'), { target: { value: 'nuovo titolo' } });
    fireEvent.click(lockButton());
    fireEvent.click(await screen.findByTestId('vault-confirm'));
    await waitFor(() => expect(moveIn).toHaveBeenCalledTimes(1));
    expect(updateNote).toHaveBeenCalledWith('n1', { title: 'nuovo titolo' });
    expect(updateNoteLocalOnly).not.toHaveBeenCalled();
    expect(order).toEqual(['updateNote', 'syncPush', 'moveIn']);
  });

  it('durante lo spostamento editor e titolo non sono modificabili, con stato di attesa; a errore tornano modificabili', async () => {
    let fail!: (e: unknown) => void;
    moveIn.mockImplementation(() => new Promise((_res, rej) => { fail = rej; }));
    render(<NoteEditor note={mkNote()} />);
    const title = screen.getByPlaceholderText('notes.titlePlaceholder') as HTMLInputElement;
    expect(title.readOnly).toBe(false);
    expect(screen.getByTestId('type').getAttribute('data-editable')).toBe('true');
    fireEvent.click(lockButton());
    await waitFor(() => expect(moveIn).toHaveBeenCalledTimes(1));
    expect(title.readOnly).toBe(true);
    expect(screen.getByTestId('type').getAttribute('data-editable')).toBe('false');
    expect(screen.getByRole('status').textContent).toContain('vault.moveIn.moving');
    fail(new MoveErr('pending'));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('vault.moveIn.pending'));
    expect(title.readOnly).toBe(false);
    expect(screen.getByTestId('type').getAttribute('data-editable')).toBe('true');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('durante lo spostamento anche i controlli dei metadati (notebook, tag, promemoria) sono disabilitati; a errore tornano attivi', async () => {
    let fail!: (e: unknown) => void;
    moveIn.mockImplementation(() => new Promise((_res, rej) => { fail = rej; }));
    render(<NoteEditor note={mkNote()} />);
    const meta = screen.getByTestId('meta-controls');
    const bell = screen.getAllByTitle('notes.addReminder')[0] as HTMLButtonElement;
    expect(meta.hasAttribute('inert')).toBe(false);
    expect(bell.disabled).toBe(false);
    fireEvent.click(lockButton());
    await waitFor(() => expect(moveIn).toHaveBeenCalledTimes(1));
    expect(meta.hasAttribute('inert')).toBe(true);
    expect(bell.disabled).toBe(true);
    fail(new MoveErr('pending'));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(meta.hasAttribute('inert')).toBe(false);
    expect(bell.disabled).toBe(false);
  });

  it('onCommitted da un istanza smontata (altra nota aperta nel frattempo): niente onBack, la query si invalida comunque', async () => {
    let commit!: () => void;
    moveIn.mockImplementation((_id: string, args: { onCommitted?: () => void }) => new Promise<void>((res) => { commit = () => { args.onCommitted?.(); res(); }; }));
    const onBack = vi.fn();
    const first = render(<NoteEditor note={mkNote()} onBack={onBack} />);
    fireEvent.click(lockButton());
    await waitFor(() => expect(moveIn).toHaveBeenCalledTimes(1));
    first.unmount();
    render(<NoteEditor note={mkNote({ id: 'n2' })} onBack={onBack} />);
    await act(async () => { commit(); });
    expect(onBack).not.toHaveBeenCalled();
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.notes.detail('n1') });
  });

  it('flush fallito (Dexie): lo spostamento si ferma, moveIn non parte, toast failed, l editor torna modificabile', async () => {
    updateNote.mockRejectedValueOnce(new Error('idb'));
    render(<NoteEditor note={mkNote()} />);
    fireEvent.click(screen.getByTestId('type'));
    fireEvent.click(lockButton());
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('vault.moveIn.failed'));
    expect(moveIn).not.toHaveBeenCalled();
    expect(syncPush).not.toHaveBeenCalled();
    expect(screen.getByTestId('type').getAttribute('data-editable')).toBe('true');
  });

  it('testo digitato durante la GET del keyring (ramo setup): il flush legge i valori correnti, non quelli del click', async () => {
    let resolveState!: (v: string) => void;
    vaultEntryState.mockImplementation(() => new Promise((res) => { resolveState = res; }));
    render(<NoteEditor note={mkNote()} />);
    fireEvent.click(lockButton());
    fireEvent.click(screen.getByTestId('type')); // digitato mentre la GET e in volo
    resolveState('setup');
    await screen.findByTestId('navigate');
    expect(updateNote).toHaveBeenCalledWith('n1', { content: '{"type":"doc","content":[{"typed":"just now"}]}' });
  });

  it('spostamento in corso su n1 (stato di modulo): una nuova istanza nasce in sola lettura, non scrive, e si libera a fine spostamento', async () => {
    moving.add('n1'); // un'altra istanza ha un moveIn pendente su questa nota
    render(<NoteEditor note={mkNote()} />);
    expect((screen.getByPlaceholderText('notes.titlePlaceholder') as HTMLInputElement).readOnly).toBe(true);
    expect(screen.getByTestId('type').getAttribute('data-editable')).toBe('false');
    expect((screen.getAllByTitle('notes.addToVault')[0] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('type')); // l'Editor finto "digita" comunque: gli effetti di salvataggio non devono scrivere
    fireEvent.change(screen.getByPlaceholderText('notes.titlePlaceholder'), { target: { value: 'altro' } });
    await act(async () => { await new Promise((r) => setTimeout(r, 1300)); });
    expect(updateContent).not.toHaveBeenCalled();
    expect(updateTitle).not.toHaveBeenCalled();
    expect(updateNote).not.toHaveBeenCalled();
    expect(saveNote).not.toHaveBeenCalled();
    // fine dello spostamento: lo stato si libera e l'istanza torna modificabile
    act(() => { moving.delete('n1'); listeners.forEach((l) => l()); });
    expect(screen.getByTestId('type').getAttribute('data-editable')).toBe('true');
    expect((screen.getByPlaceholderText('notes.titlePlaceholder') as HTMLInputElement).readOnly).toBe(false);
  });

  it('spostamento in corso: pin ed eliminazione disabilitati, saveNote dei metadati non scrive', async () => {
    let fail!: (e: unknown) => void;
    moveIn.mockImplementation(() => new Promise((_res, rej) => { fail = rej; }));
    render(<NoteEditor note={mkNote()} />);
    fireEvent.click(lockButton());
    await waitFor(() => expect(moveIn).toHaveBeenCalledTimes(1));
    expect((screen.getAllByTitle('notes.pin')[0] as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getAllByTitle('common.delete')[0] as HTMLButtonElement).disabled).toBe(true);
    fail(new MoveErr('failed'));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect((screen.getAllByTitle('notes.pin')[0] as HTMLButtonElement).disabled).toBe(false);
  });
});
