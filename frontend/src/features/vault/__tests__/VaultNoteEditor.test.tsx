// Vault v3 (T18): VaultNoteEditor. Codec, lock, Dexie e rete finti; si verifica cosa viene scritto e quando.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';

/* eslint-disable @typescript-eslint/no-explicit-any -- mock Vitest */
const h = vi.hoisted(() => ({
  row: null as any,
  updateNote: vi.fn(),
  permanentlyDeleteNote: vi.fn(),
  hydrate: vi.fn(),
  encrypt: vi.fn(),
  moveOut: vi.fn(),
  touch: vi.fn(),
  flushers: [] as Array<(ctx: any) => Promise<void> | void>,
  lockOpts: [] as any[],
  lockHeld: { v: false },
  lockStatus: { v: 'ran' as 'ran' | 'nolocks' },
  lockThrows: { v: false }, // la richiesta del lock lancia (bfcache/prerender)
  user: { v: { id: 'u1' } as { id: string } | null },
  getFails: { v: false },
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
  editorProps: [] as any[],
  tagProps: [] as any[],
  toastError: vi.fn(),
  events: [] as string[],
  echo: { v: false }, // l'editor vero riemette onChange(content) al mount e a ogni setEditable (difetto 2.1)
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('react-hot-toast', () => ({ default: Object.assign((...a: unknown[]) => h.toastInfo(...a), { error: (...a: unknown[]) => h.toastError(...a), success: (...a: unknown[]) => h.toastSuccess(...a) }) }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('../../notes/noteService', () => ({
  updateNote: (...a: unknown[]) => { h.events.push('updateNote'); return h.updateNote(...a); },
  permanentlyDeleteNote: (...a: unknown[]) => h.permanentlyDeleteNote(...a),
}));
vi.mock('../../../lib/db', () => ({ db: { notes: { get: async () => { if (h.getFails.v) throw new Error('idb'); return h.row; } } } }));
vi.mock('../../../lib/vaultReconcile', () => ({ hydrateVaultNote: (...a: unknown[]) => { h.events.push('hydrate'); return h.hydrate(...a); } }));
vi.mock('../../../lib/vaultNoteLock', () => ({
  withNoteLock: async (_id: string, fn: () => Promise<unknown>, opts: unknown) => {
    h.lockOpts.push(opts);
    if (h.lockThrows.v) throw new Error('InvalidStateError');
    if (h.lockStatus.v === 'nolocks') return { status: 'nolocks' };
    h.lockHeld.v = true;
    h.events.push('lock');
    try { return { status: 'ran', value: await fn() }; } finally { h.lockHeld.v = false; h.events.push('unlock'); }
  },
}));
vi.mock('../../../lib/vaultCodec', () => ({
  encryptItem: (...a: unknown[]) => h.encrypt(...a),
  decryptItem: async (_id: string, _t: string, env: string) => JSON.parse(unb64u(env.slice(env.lastIndexOf('.') + 1))),
}));
vi.mock('../../../lib/vaultMove', () => ({
  moveOut: (...a: unknown[]) => h.moveOut(...a),
  VaultMoveError: class extends Error { code: string; constructor(c = 'failed') { super(c); this.code = c; } },
}));
vi.mock('../../../store/authStore', () => ({ useAuthStore: { getState: () => ({ user: h.user.v }) } }));
vi.mock('../../../store/vaultStore', () => ({
  useVaultStore: { getState: () => ({ touchVault: h.touch, registerPreLock: (fn: any) => { h.flushers.push(fn); return () => { h.flushers.splice(h.flushers.indexOf(fn), 1); }; } }) },
}));
vi.mock('../../../components/editor/Editor', () => ({
  default: (p: any) => {
    h.editorProps.push(p);
    // eslint-disable-next-line react-hooks/rules-of-hooks, react-hooks/exhaustive-deps -- il mock e' un componente
    useEffect(() => { if (h.echo.v) p.onChange(p.content); }, [p.editable]);
    return <textarea data-testid="editor" value={p.content} readOnly={!p.editable} onChange={(e) => p.onChange(e.target.value)} />;
  },
}));
vi.mock('../../../components/editor/TagSelector', () => ({ default: (p: any) => { h.tagProps.push(p); return <div data-testid="tags" />; } }));
vi.mock('../../../components/ui/ConfirmDialog', () => ({
  ConfirmDialog: (p: any) => (p.isOpen ? <button onClick={() => { p.onConfirm(); p.onClose(); }}>{`confirm:${p.title}`}</button> : null),
}));

import VaultNoteEditor from '../VaultNoteEditor';
import { VaultMoveError } from '../../../lib/vaultMove';

// base64url senza padding, come richiede ENVELOPE_RE (almeno 22 caratteri)
const b64u = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s: string) => atob(s.replace(/-/g, '+').replace(/_/g, '/'));
const ENV = (t: string, c: string) => `nv3.1.AAAAAAAAAAAAAAAA.${b64u(JSON.stringify({ t, c }))}`;
const baseNote = { id: 'n1', title: '', content: '', tags: [], isVault: true, noteType: 'NOTE' } as any;
const flushAsync = async () => { for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); }); };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  h.row = { id: 'n1', title: '', content: ENV('Titolo', 'corpo') };
  h.updateNote.mockReset().mockResolvedValue(undefined);
  h.permanentlyDeleteNote.mockReset().mockResolvedValue(undefined);
  h.hydrate.mockReset().mockResolvedValue(false);
  h.encrypt.mockReset().mockImplementation(async (_id: string, _t: string, item: any) => ENV(item.t, item.c));
  h.moveOut.mockReset().mockResolvedValue(undefined);
  h.touch.mockReset();
  h.toastSuccess.mockReset();
  h.toastInfo.mockReset();
  h.lockStatus.v = 'ran';
  h.lockThrows.v = false;
  h.user.v = { id: 'u1' };
  h.getFails.v = false;
  h.toastError.mockReset();
  h.flushers.length = 0;
  h.lockOpts.length = 0;
  h.editorProps.length = 0;
  h.tagProps.length = 0;
  h.events.length = 0;
  h.echo.v = false;
});
afterEach(() => { vi.useRealTimers(); });

const open = async (note = baseNote, onBack = vi.fn()) => {
  const r = render(<VaultNoteEditor note={note} onBack={onBack} />);
  await flushAsync();
  return { ...r, onBack };
};

describe('VaultNoteEditor', () => {
  it('prende il lock shared, idrata DENTRO il lock, decifra e non passa noteId/provider/collaboration', async () => {
    await open();
    expect(h.lockOpts[0]).toEqual({ mode: 'shared' });
    expect(h.events.slice(0, 2)).toEqual(['lock', 'hydrate']);
    expect(h.lockHeld.v).toBe(true); // tenuto finche' e' montato
    expect((screen.getByTestId('editor') as HTMLTextAreaElement).value).toBe('corpo');
    expect((screen.getByLabelText('notes.titlePlaceholder') as HTMLInputElement).value).toBe('Titolo');
    const p = h.editorProps.at(-1);
    expect(p.isVault).toBe(true);
    expect(p.noteId).toBeUndefined();
    expect(p.provider).toBeUndefined();
    expect(p.collaboration).toBeUndefined();
    expect(h.tagProps.at(-1)).toMatchObject({ noteId: 'n1', isVault: true });
  });

  it('rilascia il lock allo smontaggio', async () => {
    const { unmount } = await open();
    unmount();
    await flushAsync();
    expect(h.lockHeld.v).toBe(false);
  });

  it('salvataggio con debounce 1 s: solo {content: envelope}, mai title; touchVault a ogni cambio', async () => {
    await open();
    fireEvent.change(screen.getByTestId('editor'), { target: { value: 'nuovo' } });
    expect(h.touch).toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(999); });
    expect(h.updateNote).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(2); });
    await flushAsync();
    expect(h.updateNote).toHaveBeenCalledTimes(1);
    const [id, data] = h.updateNote.mock.calls[0];
    expect(id).toBe('n1');
    expect(Object.keys(data)).toEqual(['content']);
    expect(data.content).toBe(ENV('Titolo', 'nuovo'));
  });

  it('il titolo finisce nell envelope (t), non in Dexie', async () => {
    await open();
    fireEvent.change(screen.getByLabelText('notes.titlePlaceholder'), { target: { value: 'Altro' } });
    await act(async () => { vi.advanceTimersByTime(1100); });
    await flushAsync();
    expect(h.encrypt.mock.calls[0][2]).toEqual({ t: 'Altro', c: 'corpo' });
    expect(Object.keys(h.updateNote.mock.calls[0][1])).toEqual(['content']);
  });

  it('flusher pre-lock: scrive subito in locale con il contesto catturato', async () => {
    await open();
    expect(h.flushers).toHaveLength(1);
    fireEvent.change(screen.getByTestId('editor'), { target: { value: 'ultimo' } });
    const ctx = { keys: {}, userId: 'u1', epoch: 3 };
    await act(async () => { await h.flushers[0](ctx); });
    expect(h.encrypt.mock.calls[0][3]).toBe(ctx);
    // utente della coda = quello del contesto catturato (authStore e' gia' null al logout)
    expect(h.updateNote).toHaveBeenCalledWith('n1', { content: ENV('Titolo', 'ultimo') }, { userId: 'u1' });
    // il timer pendente e' stato annullato: nessun secondo salvataggio
    await act(async () => { vi.advanceTimersByTime(2000); });
    await flushAsync();
    expect(h.updateNote).toHaveBeenCalledTimes(1);
  });

  it('smontaggio con salvataggio pendente: scrive PRIMA di rilasciare il lock', async () => {
    const { unmount } = await open();
    fireEvent.change(screen.getByTestId('editor'), { target: { value: 'pendente' } });
    unmount();
    await flushAsync();
    expect(h.events.indexOf('updateNote')).toBeGreaterThan(-1);
    expect(h.events.indexOf('updateNote')).toBeLessThan(h.events.indexOf('unlock'));
  });

  it('envelope oltre 2 MiB: toast vault.tooLarge e nessuna scrittura', async () => {
    h.encrypt.mockResolvedValue('x'.repeat(2 * 1024 * 1024 + 1));
    await open();
    fireEvent.change(screen.getByTestId('editor'), { target: { value: 'grande' } });
    await act(async () => { vi.advanceTimersByTime(1100); });
    await flushAsync();
    expect(h.updateNote).not.toHaveBeenCalled();
    expect(h.toastError).toHaveBeenCalledWith('vault.tooLarge');
  });

  it('pin e promemoria passano da updateNote (solo metadati)', async () => {
    await open({ ...baseNote, reminderDate: '2026-10-30T10:00:00.000Z' });
    fireEvent.click(screen.getByLabelText('notes.pin'));
    expect(h.updateNote).toHaveBeenCalledWith('n1', { isPinned: true });
    fireEvent.click(screen.getByLabelText('notes.removeReminder'));
    expect(h.updateNote).toHaveBeenCalledWith('n1', { reminderDate: null, isReminderDone: false });
    expect(screen.getByLabelText('notes.editReminder')).toBeTruthy();
  });

  it('elimina definitivamente: ConfirmDialog + permanentlyDeleteNote, nessun salvataggio dopo', async () => {
    const { onBack } = await open();
    fireEvent.change(screen.getByTestId('editor'), { target: { value: 'x' } });
    fireEvent.click(screen.getByLabelText('common.delete'));
    expect(h.permanentlyDeleteNote).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByText('confirm:vault.deletePermanently')); });
    await flushAsync();
    expect(h.permanentlyDeleteNote).toHaveBeenCalledWith('n1');
    expect(onBack).toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(2000); });
    await flushAsync();
    expect(h.updateNote).not.toHaveBeenCalled();
  });

  it('togli dal vault (envelope): plaintext dalla memoria a moveOut', async () => {
    await open();
    fireEvent.change(screen.getByTestId('editor'), { target: { value: 'modificato' } });
    fireEvent.click(screen.getByLabelText('notes.removeFromVault'));
    await act(async () => { fireEvent.click(screen.getByText('confirm:vault.exitTitle')); });
    await flushAsync();
    expect(h.moveOut).toHaveBeenCalledWith('n1', expect.objectContaining({ title: 'Titolo', content: 'modificato' }));
    // nessun salvataggio envelope concorrente
    await act(async () => { vi.advanceTimersByTime(2000); });
    await flushAsync();
    expect(h.updateNote).not.toHaveBeenCalled();
  });

  it('item non envelope: sola lettura, solo "Togli dal vault", niente salvataggi', async () => {
    h.row = { id: 'n1', title: 'Vecchia', content: '{"type":"doc","content":[]}' };
    await open();
    expect(h.flushers).toHaveLength(0);
    expect(h.editorProps.at(-1).editable).toBe(false);
    expect(screen.queryByLabelText('common.delete')).toBeNull();
    expect(screen.queryByLabelText('notes.pin')).toBeNull();
    expect(screen.queryByTestId('tags')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('vault.legacyReadOnly');
    fireEvent.click(screen.getByLabelText('notes.removeFromVault'));
    await act(async () => { fireEvent.click(screen.getByText('confirm:vault.exitTitle')); });
    await flushAsync();
    expect(h.moveOut).toHaveBeenCalledWith('n1', expect.objectContaining({ title: 'Vecchia', content: '{"type":"doc","content":[]}' }));
    expect(h.updateNote).not.toHaveBeenCalled();
  });

  it('item non envelope e non JSON (cifrato legacy): niente editor e niente uscita', async () => {
    h.row = { id: 'n1', title: 'X', content: 'U2FsdGVkX1+abc' };
    await open();
    expect(screen.queryByTestId('editor')).toBeNull();
    expect(screen.queryByLabelText('notes.removeFromVault')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('vault.legacyUnreadable');
  });

  it('riga senza contenuto locale: segnaposto "non caricato", nessun editor', async () => {
    h.row = { id: 'n1', title: '', content: '' };
    await open();
    expect(screen.queryByTestId('editor')).toBeNull();
    expect(screen.getByText('vault.notLoaded')).toBeTruthy();
  });

  it('moveOut fallisce (failed): moving torna false, toast col codice, la modifica viene rischedulata e salvata', async () => {
    h.moveOut.mockRejectedValue(new VaultMoveError('failed'));
    await open();
    fireEvent.change(screen.getByTestId('editor'), { target: { value: 'modificato' } });
    fireEvent.click(screen.getByLabelText('notes.removeFromVault'));
    await act(async () => { fireEvent.click(screen.getByText('confirm:vault.exitTitle')); });
    await flushAsync();
    expect(h.toastError).toHaveBeenCalledWith('vault.moveOut.failed');
    expect(h.updateNote).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1100); });
    await flushAsync();
    expect(h.updateNote).toHaveBeenCalledWith('n1', { content: ENV('Titolo', 'modificato') }, { userId: 'u1' });
    fireEvent.change(screen.getByTestId('editor'), { target: { value: 'ancora' } });
    await act(async () => { vi.advanceTimersByTime(1100); });
    await flushAsync();
    expect(h.updateNote).toHaveBeenLastCalledWith('n1', { content: ENV('Titolo', 'ancora') }, { userId: 'u1' });
  });

  it('moveOut con conflict: salva in locale le modifiche, POI chiude l editor; toast conflict', async () => {
    h.moveOut.mockRejectedValue(new VaultMoveError('conflict'));
    const { onBack } = await open();
    fireEvent.change(screen.getByTestId('editor'), { target: { value: 'modificato' } });
    fireEvent.click(screen.getByLabelText('notes.removeFromVault'));
    await act(async () => { fireEvent.click(screen.getByText('confirm:vault.exitTitle')); });
    await flushAsync();
    expect(h.updateNote).toHaveBeenCalledWith('n1', { content: ENV('Titolo', 'modificato') }, { userId: 'u1' });
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(h.updateNote.mock.invocationCallOrder[0]).toBeLessThan(onBack.mock.invocationCallOrder[0]);
    expect(h.toastError).toHaveBeenCalledWith('vault.moveOut.conflict');
    await act(async () => { vi.advanceTimersByTime(2000); });
    await flushAsync();
    expect(h.updateNote).toHaveBeenCalledTimes(1);
  });

  it('flusher pre-lock durante moveOut: aspetta l esito e, se fallito, salva con il contesto', async () => {
    let rejectMove: (e: unknown) => void = () => {};
    h.moveOut.mockReturnValue(new Promise((_, rej) => { rejectMove = rej; }));
    await open();
    fireEvent.change(screen.getByTestId('editor'), { target: { value: 'ultimo' } });
    fireEvent.click(screen.getByLabelText('notes.removeFromVault'));
    await act(async () => { fireEvent.click(screen.getByText('confirm:vault.exitTitle')); });
    await flushAsync();
    const ctx = { keys: {}, userId: 'u1', epoch: 3 };
    let done = false;
    void Promise.resolve(h.flushers[0](ctx)).then(() => { done = true; });
    await flushAsync();
    expect(done).toBe(false);
    expect(h.updateNote).not.toHaveBeenCalled();
    await act(async () => { rejectMove(new VaultMoveError('failed')); });
    await flushAsync();
    expect(done).toBe(true);
    expect(h.updateNote).toHaveBeenCalledWith('n1', { content: ENV('Titolo', 'ultimo') }, { userId: 'u1' });
  });

  it('durante la PUT di moveOut editor e titolo sono in sola lettura (il testo digitato ora andrebbe perso); a errore tornano modificabili', async () => {
    let rejectMove: (e: unknown) => void = () => {};
    h.moveOut.mockReturnValue(new Promise((_, rej) => { rejectMove = rej; }));
    await open();
    fireEvent.click(screen.getByLabelText('notes.removeFromVault'));
    await act(async () => { fireEvent.click(screen.getByText('confirm:vault.exitTitle')); });
    await flushAsync();
    expect(h.editorProps.at(-1).editable).toBe(false);
    expect((screen.getByLabelText('notes.titlePlaceholder') as HTMLInputElement).readOnly).toBe(true);
    expect((screen.getByLabelText('notes.titlePlaceholder') as HTMLInputElement).value).toBe('Titolo'); // non il titolo iniziale della fase
    await act(async () => { rejectMove(new VaultMoveError('failed')); });
    await flushAsync();
    expect(h.editorProps.at(-1).editable).toBe(true);
    expect((screen.getByLabelText('notes.titlePlaceholder') as HTMLInputElement).readOnly).toBe(false);
  });

  it('senza utente (logout durante il salvataggio) non scrive: niente item con userId orfano', async () => {
    await open();
    fireEvent.change(screen.getByTestId('editor'), { target: { value: 'nuovo' } });
    h.user.v = null;
    await act(async () => { vi.advanceTimersByTime(1100); });
    await flushAsync();
    expect(h.updateNote).not.toHaveBeenCalled();
  });

  it('salvataggio fallito: toast, dirty ripristinato, il cambio successivo salva di nuovo', async () => {
    h.updateNote.mockRejectedValueOnce(new Error('idb'));
    await open();
    fireEvent.change(screen.getByTestId('editor'), { target: { value: 'uno' } });
    await act(async () => { vi.advanceTimersByTime(1100); });
    await flushAsync();
    expect(h.toastError).toHaveBeenCalledWith('notes.saveFailed');
    fireEvent.change(screen.getByTestId('editor'), { target: { value: 'due' } });
    await act(async () => { vi.advanceTimersByTime(1100); });
    await flushAsync();
    expect(h.updateNote).toHaveBeenCalledTimes(2);
    expect(h.updateNote).toHaveBeenLastCalledWith('n1', { content: ENV('Titolo', 'due') }, { userId: 'u1' });
  });

  it('senza Web Locks (nolocks) l editor si apre comunque', async () => {
    h.lockStatus.v = 'nolocks';
    await open();
    expect((screen.getByTestId('editor') as HTMLTextAreaElement).value).toBe('corpo');
  });

  it('errore Dexie nel caricamento: segnaposto "non caricato", non spinner infinito', async () => {
    h.getFails.v = true;
    await open();
    expect(screen.queryByTestId('editor')).toBeNull();
    expect(screen.getByText('vault.notLoaded')).toBeTruthy();
  });

  it('pin fallito: toast di errore, niente toast di successo', async () => {
    h.updateNote.mockRejectedValue(new Error('idb'));
    await open();
    fireEvent.click(screen.getByLabelText('notes.pin'));
    await flushAsync();
    expect(h.toastError).toHaveBeenCalledWith('notes.saveFailed');
    expect(h.toastSuccess).not.toHaveBeenCalled();
  });

  it('pin riuscito: toast di successo', async () => {
    await open();
    fireEvent.click(screen.getByLabelText('notes.pin'));
    await flushAsync();
    expect(h.toastSuccess).toHaveBeenCalledWith('notes.pinned');
  });

  it('"Togli dal vault" disabilitato offline, riabilitato al ritorno online', async () => {
    await open();
    const btn = screen.getByLabelText('notes.removeFromVault') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    await act(async () => { window.dispatchEvent(new Event('offline')); });
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe('vault.moveOut.offline');
    await act(async () => { window.dispatchEvent(new Event('online')); });
    expect(btn.disabled).toBe(false);
  });
});

describe('VaultNoteEditor: onChange di echo (difetto 2.1)', () => {
  beforeEach(() => { h.echo.v = true; });

  it('aprire la nota senza modificarla non scrive nulla e non tocca il timer di inattivita', async () => {
    const { unmount } = await open();
    await act(async () => { vi.advanceTimersByTime(3000); });
    await flushAsync();
    unmount();
    await flushAsync();
    expect(h.updateNote).not.toHaveBeenCalled();
    expect(h.touch).not.toHaveBeenCalled();
  });

  it('moveOut fallisce (failed) con la riemissione dell editor: nessuna scrittura', async () => {
    h.moveOut.mockRejectedValue(new VaultMoveError('failed'));
    await open();
    fireEvent.click(screen.getByLabelText('notes.removeFromVault'));
    await act(async () => { fireEvent.click(screen.getByText('confirm:vault.exitTitle')); });
    await flushAsync();
    await act(async () => { vi.advanceTimersByTime(3000); });
    await flushAsync();
    expect(h.toastError).toHaveBeenCalledWith('vault.moveOut.failed');
    expect(h.updateNote).not.toHaveBeenCalled();
  });

  it('una modifica vera salva una volta sola', async () => {
    await open();
    fireEvent.change(screen.getByTestId('editor'), { target: { value: 'nuovo' } });
    await act(async () => { vi.advanceTimersByTime(1100); });
    await flushAsync();
    expect(h.updateNote).toHaveBeenCalledTimes(1);
    expect(h.updateNote.mock.calls[0][1].content).toBe(ENV('Titolo', 'nuovo'));
  });

  it('modifica e ritorno al testo originale entro il debounce: si salva l originale', async () => {
    await open();
    fireEvent.change(screen.getByTestId('editor'), { target: { value: 'nuovo' } });
    fireEvent.change(screen.getByTestId('editor'), { target: { value: 'corpo' } });
    await act(async () => { vi.advanceTimersByTime(1100); });
    await flushAsync();
    expect(h.updateNote).toHaveBeenCalledTimes(1);
    expect(h.updateNote.mock.calls[0][1].content).toBe(ENV('Titolo', 'corpo'));
  });
});

describe('VaultNoteEditor: immagini remote e file (F.13)', () => {
  const img = (src: string) => ({ type: 'image', attrs: { src } });
  const docWith = (...n: unknown[]) => JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }, ...n] }] });

  it('envelope con immagine remota: l editor riceve il corpo senza, avviso, nessuna scrittura', async () => {
    h.row = { id: 'n1', title: '', content: ENV('T', docWith(img('https://evil.example/p.png'), img('/uploads/ok.png'))) };
    await open();
    const body = (screen.getByTestId('editor') as HTMLTextAreaElement).value;
    expect(body).not.toContain('evil.example');
    expect(body).toContain('/uploads/ok.png');
    expect(h.toastInfo).toHaveBeenCalledWith('vault.remoteImagesHidden');
    await act(async () => { vi.advanceTimersByTime(3000); });
    await flushAsync();
    expect(h.updateNote).not.toHaveBeenCalled();
  });

  it('sola lettura (legacy doc): immagine remota tolta dal contenuto dell editor, avviso', async () => {
    h.row = { id: 'n1', title: 'Vecchia', content: docWith(img('http://evil.example/p.png')) };
    await open();
    expect((screen.getByTestId('editor') as HTMLTextAreaElement).value).not.toContain('evil.example');
    expect(h.toastInfo).toHaveBeenCalledWith('vault.remoteImagesHidden');
  });

  it('drop di un file sull header: niente navigazione, avviso', async () => {
    await open();
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    const notPrevented = fireEvent.drop(screen.getByLabelText('notes.titlePlaceholder'), { dataTransfer: { types: ['Files'], files: [file] } });
    expect(notPrevented).toBe(false);
    expect(h.toastError).toHaveBeenCalledWith('vault.imagesBlocked', { id: 'vault.imagesBlocked' });
  });

  it('dragover di un file viene accettato (altrimenti il drop non parte e il browser apre il file)', async () => {
    await open();
    expect(fireEvent.dragOver(screen.getByLabelText('notes.titlePlaceholder'), { dataTransfer: { types: ['Files'], files: [] } })).toBe(false);
  });
});

describe('VaultNoteEditor: onReleased (T-c)', () => {
  const openWith = async (onReleased: () => void) => {
    const r = render(<VaultNoteEditor note={baseNote} onBack={vi.fn()} onReleased={onReleased} />);
    await flushAsync();
    return r;
  };

  it('una sola volta, a smontaggio, dopo l ultimo updateNote e dopo lo sblocco', async () => {
    const onReleased = vi.fn(() => { h.events.push('released'); });
    const { unmount } = await openWith(onReleased);
    expect(onReleased).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('editor'), { target: { value: 'nuovo' } });
    unmount();
    await flushAsync();
    expect(onReleased).toHaveBeenCalledTimes(1);
    expect(h.events.slice(-3)).toEqual(['updateNote', 'unlock', 'released']);
  });

  it('senza Web Locks (nolocks): una volta sola, dopo updateNote', async () => {
    h.lockStatus.v = 'nolocks';
    const onReleased = vi.fn(() => { h.events.push('released'); });
    const { unmount } = await openWith(onReleased);
    fireEvent.change(screen.getByTestId('editor'), { target: { value: 'nuovo' } });
    unmount();
    await flushAsync();
    expect(onReleased).toHaveBeenCalledTimes(1);
    expect(h.events.slice(-2)).toEqual(['updateNote', 'released']);
  });

  it('la richiesta del lock lancia: onReleased parte comunque, una volta sola', async () => {
    h.lockThrows.v = true;
    const onReleased = vi.fn();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = await openWith(onReleased);
    expect(onReleased).not.toHaveBeenCalled();
    unmount();
    await flushAsync();
    expect(onReleased).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it('Riprova dopo un load fallito: il re-run dell effetto non chiama onReleased, lo smontaggio si, una volta', async () => {
    h.getFails.v = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onReleased = vi.fn();
    const { unmount } = await openWith(onReleased);
    h.getFails.v = false;
    fireEvent.click(screen.getByText('vault.notLoadedRetry'));
    await flushAsync();
    expect(screen.getByTestId('editor')).toBeTruthy();
    expect(onReleased).not.toHaveBeenCalled();
    unmount();
    await flushAsync();
    expect(onReleased).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it('senza la prop onReleased lo smontaggio non lancia', async () => {
    const { unmount } = await open();
    unmount();
    await flushAsync();
    expect(h.lockHeld.v).toBe(false);
  });
});

describe('VaultNoteEditor: drop su editor non modificabile', () => {
  const file = new File(['x'], 'a.png', { type: 'image/png' });
  // come ImageDrop: il suo handler nativo blocca il drop (preventDefault) PRIMA che arrivi al wrapper React
  const blockLikeImageDrop = () => screen.getByTestId('editor').addEventListener('drop', (e) => e.preventDefault());
  const dropOnEditor = () => fireEvent.drop(screen.getByTestId('editor'), { dataTransfer: { types: ['Files'], files: [file] } });
  const imagesBlocked = () => h.toastError.mock.calls.filter((c) => c[0] === 'vault.imagesBlocked');

  it('editor non modificabile (legacy con docOk): il drop gia bloccato da ImageDrop in silenzio ora mostra l avviso', async () => {
    h.row = { id: 'n1', title: 'Vecchia', content: '{"type":"doc","content":[]}' };
    await open();
    expect(h.editorProps.at(-1).editable).toBe(false);
    blockLikeImageDrop();
    expect(dropOnEditor()).toBe(false);
    expect(imagesBlocked()).toHaveLength(1);
    expect(imagesBlocked()[0][1]).toEqual({ id: 'vault.imagesBlocked' });
  });

  it('editor non modificabile (moveOut in volo): avviso al drop', async () => {
    h.moveOut.mockReturnValue(new Promise(() => {}));
    await open();
    fireEvent.click(screen.getByLabelText('notes.removeFromVault'));
    await act(async () => { fireEvent.click(screen.getByText('confirm:vault.exitTitle')); });
    await flushAsync();
    expect(h.editorProps.at(-1).editable).toBe(false);
    blockLikeImageDrop();
    dropOnEditor();
    expect(imagesBlocked()).toHaveLength(1);
  });

  it('editor modificabile e drop gia bloccato da ImageDrop (che ha gia avvisato): il wrapper non duplica', async () => {
    await open();
    expect(h.editorProps.at(-1).editable).toBe(true);
    blockLikeImageDrop();
    dropOnEditor();
    expect(imagesBlocked()).toHaveLength(0);
  });
});
