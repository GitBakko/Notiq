import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act, screen } from '@testing-library/react';

const updateNote = vi.fn();
const permanentlyDeleteNote = vi.fn();
vi.mock('../../notes/noteService', () => ({
  updateNote: (...a: unknown[]) => updateNote(...a),
  permanentlyDeleteNote: (...a: unknown[]) => permanentlyDeleteNote(...a),
}));

const touchVault = vi.fn();
const preLock: { fn: ((ctx: unknown) => Promise<void>) | null } = { fn: null };
const state = {
  keys: {} as unknown,
  touchVault,
  registerPreLock: (fn: (ctx: unknown) => Promise<void>) => {
    preLock.fn = fn;
    return () => { preLock.fn = null; };
  },
};
vi.mock('../../../store/vaultStore', () => ({
  useVaultStore: Object.assign((sel: (s: typeof state) => unknown) => sel(state), { getState: () => state }),
}));

// withNoteLock finto: tiene il lock finche' la promessa di fn non si risolve. gate = concessione in ritardo; nolocks = niente Web Locks
const lock = { held: false, id: '', opts: null as unknown, gate: null as Promise<void> | null, nolocks: false, reject: false };
vi.mock('../../../lib/vaultNoteLock', () => ({
  withNoteLock: (id: string, fn: () => Promise<unknown>, opts: unknown) => {
    if (lock.nolocks) return Promise.resolve({ status: 'nolocks' });
    if (lock.reject) return Promise.reject(new DOMException('bfcache', 'InvalidStateError'));
    const run = () => {
      lock.held = true; lock.id = id; lock.opts = opts;
      return Promise.resolve(fn()).then((v) => ({ status: 'ran', value: v })).finally(() => { lock.held = false; });
    };
    return lock.gate ? lock.gate.then(run) : run();
  },
}));

const decryptItem = vi.fn();
const encryptItem = vi.fn();
vi.mock('../../../lib/vaultCodec', () => ({
  decryptItem: (...a: unknown[]) => decryptItem(...a),
  encryptItem: (...a: unknown[]) => encryptItem(...a),
}));
const toastError = vi.fn();
vi.mock('react-hot-toast', () => ({ default: { error: (...a: unknown[]) => toastError(...a), success: vi.fn() } }));
vi.mock('../../../lib/api', () => ({ default: { get: vi.fn() } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import CredentialForm from '../CredentialForm';

const ENV = 'nv3.1.AAAAAAAAAAAAAAAA.' + 'A'.repeat(30);
const empty = { id: 'n1', title: '', content: '', noteType: 'CREDENTIAL', isVault: true } as never;
const loadedNote = { id: 'n1', title: '', content: ENV, noteType: 'CREDENTIAL', isVault: true } as never;
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe('CredentialForm with never-hydrated content', () => {
  beforeEach(() => { vi.useFakeTimers(); updateNote.mockClear(); decryptItem.mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

  it('never calls updateNote when content is empty (typing + timers + unmount)', () => {
    const { container, unmount } = render(<CredentialForm note={empty} onBack={() => {}} />);
    // Fields must not be editable; if any input exists, typing into it must still not save
    container.querySelectorAll('input').forEach((i) => fireEvent.change(i, { target: { value: 'x' } }));
    act(() => { vi.advanceTimersByTime(5000); });
    unmount();
    expect(updateNote).not.toHaveBeenCalled();
    expect(container.querySelectorAll('input').length).toBe(0);
    expect(decryptItem).not.toHaveBeenCalled();
  });
});

describe('CredentialForm envelope save', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    updateNote.mockReset().mockResolvedValue(undefined);
    toastError.mockClear();
    touchVault.mockClear();
    permanentlyDeleteNote.mockReset().mockResolvedValue(undefined);
    state.keys = {};
    lock.held = false; lock.gate = null; lock.nolocks = false; lock.reject = false;
    decryptItem.mockReset().mockResolvedValue({ t: 'Mail', c: JSON.stringify({ siteUrl: '', username: 'bob', password: 'pw', notes: '' }) });
    encryptItem.mockReset().mockResolvedValue(ENV);
  });
  afterEach(() => { vi.useRealTimers(); });

  async function mount() {
    const r = render(<CredentialForm note={loadedNote} onBack={() => {}} />);
    await flush();
    return r;
  }

  it('decrypts the envelope: title from t, no input before it is loaded', async () => {
    const r = render(<CredentialForm note={loadedNote} onBack={() => {}} />);
    expect(r.container.querySelectorAll('input').length).toBe(0);
    await flush();
    expect(decryptItem).toHaveBeenCalledWith('n1', 'CREDENTIAL', ENV);
    expect((screen.getByPlaceholderText('vault.credential.untitled') as HTMLInputElement).value).toBe('Mail');
  });

  it('saves an envelope with t and c, awaited, and never a title', async () => {
    await mount();
    fireEvent.change(screen.getByPlaceholderText('vault.credential.untitled'), { target: { value: 'Posta' } });
    expect(touchVault).toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(encryptItem).toHaveBeenCalledTimes(1);
    const [id, type, item] = encryptItem.mock.calls[0];
    expect([id, type, item.t]).toEqual(['n1', 'CREDENTIAL', 'Posta']);
    expect(JSON.parse(item.c)).toMatchObject({ username: 'bob', password: 'pw' });
    expect(updateNote).toHaveBeenCalledWith('n1', { content: ENV });
    expect(updateNote.mock.calls[0][1]).not.toHaveProperty('title');
  });

  it('shows an error toast when updateNote rejects (guard)', async () => {
    updateNote.mockRejectedValue(new Error('vault.plaintextGuard'));
    await mount();
    fireEvent.change(screen.getByPlaceholderText('vault.credential.untitled'), { target: { value: 'x' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(toastError).toHaveBeenCalledWith('notes.saveFailed');
  });

  it('does not write an envelope over 2 MiB', async () => {
    encryptItem.mockResolvedValue('x'.repeat(2 * 1024 * 1024 + 1));
    await mount();
    fireEvent.change(screen.getByPlaceholderText('vault.credential.untitled'), { target: { value: 'x' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(updateNote).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith('vault.tooLarge');
  });

  it('pre-lock flush saves the pending edit with the captured keys', async () => {
    await mount();
    fireEvent.change(screen.getByPlaceholderText('vault.credential.untitled'), { target: { value: 'Late' } });
    const ctx = { keys: {}, userId: 'u', epoch: 1 };
    await act(async () => { await preLock.fn!(ctx); });
    expect(encryptItem.mock.calls[0][3]).toBe(ctx);
    expect(updateNote).toHaveBeenCalledTimes(1);
    expect(updateNote.mock.calls[0][2]).toEqual({ userId: 'u' });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(updateNote).toHaveBeenCalledTimes(1); // timer cancelled by the flush
  });

  it('lockVault before unmount with a pending edit: saved once with ctx, no toast, no save after the keys are gone', async () => {
    const r = await mount();
    fireEvent.change(screen.getByPlaceholderText('vault.credential.untitled'), { target: { value: 'Late' } });
    const ctx = { keys: {}, userId: 'u', epoch: 1 };
    await act(async () => { await preLock.fn!(ctx); });
    state.keys = null; // lockVault azzera le chiavi
    r.unmount();
    await flush();
    expect(encryptItem).toHaveBeenCalledTimes(1);
    expect(encryptItem.mock.calls[0][3]).toBe(ctx);
    expect(updateNote).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it('keys already null at unmount: the cleanup does not save (the pre-lock flusher owns it), no toast', async () => {
    const r = await mount();
    fireEvent.change(screen.getByPlaceholderText('vault.credential.untitled'), { target: { value: 'x' } });
    state.keys = null;
    r.unmount();
    await flush();
    expect(encryptItem).not.toHaveBeenCalled();
    expect(updateNote).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('failed save stays dirty: unmount without further edits retries the write', async () => {
    updateNote.mockRejectedValueOnce(new Error('dexie'));
    const r = await mount();
    fireEvent.change(screen.getByPlaceholderText('vault.credential.untitled'), { target: { value: 'x' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(updateNote).toHaveBeenCalledTimes(1);
    r.unmount();
    await flush();
    expect(updateNote).toHaveBeenCalledTimes(2);
  });

  it('successful save clears dirty: unmount does not write again', async () => {
    const r = await mount();
    fireEvent.change(screen.getByPlaceholderText('vault.credential.untitled'), { target: { value: 'x' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    r.unmount();
    await flush();
    expect(updateNote).toHaveBeenCalledTimes(1);
  });

  it('holds the shared note lock for the whole life and releases it after the last flush', async () => {
    const heldAtWrite: boolean[] = [];
    updateNote.mockImplementation(async () => { heldAtWrite.push(lock.held); });
    const r = await mount();
    expect(lock).toMatchObject({ held: true, id: 'n1', opts: { mode: 'shared' } });
    fireEvent.change(screen.getByPlaceholderText('vault.credential.untitled'), { target: { value: 'x' } });
    r.unmount();
    await flush();
    await flush();
    expect(heldAtWrite).toEqual([true]);
    expect(lock.held).toBe(false);
  });

  it('delete: pending edit is dropped, nothing is written after the delete, failure shows a toast', async () => {
    const r = await mount();
    fireEvent.change(screen.getByPlaceholderText('vault.credential.untitled'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTitle('common.delete'));
    await act(async () => { fireEvent.click(screen.getByText('common.delete')); await Promise.resolve(); });
    await flush();
    expect(permanentlyDeleteNote).toHaveBeenCalledWith('n1');
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    r.unmount();
    await flush();
    expect(updateNote).not.toHaveBeenCalled();
  });

  it('delete failure: toast, no navigation', async () => {
    permanentlyDeleteNote.mockRejectedValue(new Error('boom'));
    await mount();
    fireEvent.click(screen.getByTitle('common.delete'));
    await act(async () => { fireEvent.click(screen.getByText('common.delete')); await Promise.resolve(); });
    await flush();
    expect(toastError).toHaveBeenCalledWith('notes.saveFailed');
  });

  it('lock granted late: no decrypt and no input before the grant, then the form loads', async () => {
    let open!: () => void;
    lock.gate = new Promise<void>((r) => { open = r; });
    const r = render(<CredentialForm note={loadedNote} onBack={() => {}} />);
    await flush();
    expect(decryptItem).not.toHaveBeenCalled();
    expect(r.container.querySelectorAll('input').length).toBe(0);
    await act(async () => { open(); await Promise.resolve(); });
    await flush();
    expect(decryptItem).toHaveBeenCalledTimes(1);
    expect((screen.getByPlaceholderText('vault.credential.untitled') as HTMLInputElement).value).toBe('Mail');
  });

  it('no Web Locks: decrypts straight away', async () => {
    lock.nolocks = true;
    await mount();
    expect(decryptItem).toHaveBeenCalledTimes(1);
    expect(screen.getByPlaceholderText('vault.credential.untitled')).toBeTruthy();
  });

  it('withNoteLock rejects (InvalidStateError): treated as no Web Locks, form still loads', async () => {
    lock.reject = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await mount();
    expect(decryptItem).toHaveBeenCalledTimes(1);
    expect(screen.getByPlaceholderText('vault.credential.untitled')).toBeTruthy();
    err.mockRestore();
  });

  const ENV2 = 'nv3.1.BBBBBBBBBBBBBBBB.' + 'B'.repeat(30);
  const withContent = (content: string) => ({ ...(loadedNote as object), content }) as never;

  it('external content change with no local edits: decrypts again', async () => {
    const r = await mount();
    decryptItem.mockResolvedValue({ t: 'Posta', c: JSON.stringify({ siteUrl: '', username: 'amy', password: 'pw', notes: '' }) });
    r.rerender(<CredentialForm note={withContent(ENV2)} onBack={() => {}} />);
    await flush();
    expect(decryptItem).toHaveBeenCalledTimes(2);
    expect((screen.getByPlaceholderText('vault.credential.untitled') as HTMLInputElement).value).toBe('Posta');
  });

  it('external content change over a pending local edit: the edit is kept, no new decrypt', async () => {
    const r = await mount();
    fireEvent.change(screen.getByPlaceholderText('vault.credential.untitled'), { target: { value: 'Mine' } });
    r.rerender(<CredentialForm note={withContent(ENV2)} onBack={() => {}} />);
    await flush();
    expect(decryptItem).toHaveBeenCalledTimes(1);
    expect((screen.getByPlaceholderText('vault.credential.untitled') as HTMLInputElement).value).toBe('Mine');
  });

  it('the envelope written by the form comes back through the row: not decrypted again', async () => {
    encryptItem.mockResolvedValue(ENV2);
    const r = await mount();
    fireEvent.change(screen.getByPlaceholderText('vault.credential.untitled'), { target: { value: 'x' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    r.rerender(<CredentialForm note={withContent(ENV2)} onBack={() => {}} />);
    await flush();
    expect(decryptItem).toHaveBeenCalledTimes(1);
  });

  it('pre-lock flush retries a failed save that left no timer (dirty only), with the captured user', async () => {
    updateNote.mockRejectedValueOnce(new Error('dexie'));
    await mount();
    fireEvent.change(screen.getByPlaceholderText('vault.credential.untitled'), { target: { value: 'x' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(updateNote).toHaveBeenCalledTimes(1); // fallito: dirty resta true, nessun timer
    await act(async () => { await preLock.fn!({ keys: {}, userId: 'u', epoch: 1 }); });
    expect(updateNote).toHaveBeenCalledTimes(2);
    expect(updateNote.mock.calls[1][2]).toEqual({ userId: 'u' });
  });

  it('VaultLockedError on save: no toast, stays dirty for the unmount retry', async () => {
    encryptItem.mockRejectedValueOnce(Object.assign(new Error('locked'), { name: 'VaultLockedError' }));
    const r = await mount();
    fireEvent.change(screen.getByPlaceholderText('vault.credential.untitled'), { target: { value: 'x' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(toastError).not.toHaveBeenCalled();
    expect(updateNote).not.toHaveBeenCalled();
    r.unmount();
    await flush();
    expect(updateNote).toHaveBeenCalledTimes(1);
  });

  it('real lockVault order (flusher queued before the child cleanup): the note lock outlives the flusher write', async () => {
    const heldAtWrite: boolean[] = [];
    updateNote.mockRejectedValueOnce(new Error('dexie'));
    const r = await mount();
    fireEvent.change(screen.getByPlaceholderText('vault.credential.untitled'), { target: { value: 'x' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); // fallito: dirty, nessun timer
    updateNote.mockClear();
    encryptItem.mockImplementation(() => new Promise((res) => setTimeout(() => res(ENV), 50)));
    updateNote.mockImplementation(async () => { heldAtWrite.push(lock.held); });
    state.keys = null; // lockVault azzera le chiavi; i flusher partono in un microtask
    const fn = preLock.fn!; // lockVault copia i flusher prima dei cleanup (poi l'unmount li deregistra)
    const flusher = Promise.resolve().then(() => fn({ keys: {}, userId: 'u', epoch: 1 }));
    r.unmount(); // i cleanup girano prima del flusher
    await act(async () => { await vi.advanceTimersByTimeAsync(100); await flusher; }); // cifratura lenta: il rilascio immediato lo si vedrebbe
    await flush();
    expect(updateNote).toHaveBeenCalledTimes(1);
    expect(heldAtWrite).toEqual([true]);
    expect(lock.held).toBe(false);
  });

  it('decrypt failure: error state, nothing is saved', async () => {
    decryptItem.mockRejectedValue(new Error('bad tag'));
    const r = render(<CredentialForm note={loadedNote} onBack={() => {}} />);
    await flush();
    expect(toastError).toHaveBeenCalledWith('vault.credential.decryptFailed');
    expect(r.container.querySelectorAll('input').length).toBe(0);
    r.unmount();
    expect(updateNote).not.toHaveBeenCalled();
  });
});
