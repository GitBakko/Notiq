// Vault P4 Fase 4 (T6): macchina a stati di VaultRecovery. Lib, form del codice e foglio del Kit finti; si verifica quale schermata esce e quante chiamate partono.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup, within } from '@testing-library/react';

/* eslint-disable @typescript-eslint/no-explicit-any -- mock Vitest */
const h = vi.hoisted(() => ({
  localRecovery: vi.fn(),
  syncLocalRecovery: vi.fn(),
  startRecovery: vi.fn(),
  completeRecovery: vi.fn(),
  openCtx: vi.fn(), // openRecoveryContext (T11)
  finish: vi.fn(),
  rewrap: vi.fn(),
  permDelete: vi.fn(),
  syncPush: vi.fn(),
  toastOk: vi.fn(),
  toastErr: vi.fn(),
  getRecovery: vi.fn(),
  getKeyring: vi.fn(),
  cancelRecovery: vi.fn(),
  checkPin: vi.fn(),
  codeProps: [] as any[],
  dialogProps: null as any, // ultime props di StaleNotesDialog (per invocare gli handler due volte prima del flush)
  rows: [] as any[], // db.notes (T11 fix 2: righe locali non sincronizzate)
  queue: [] as any[], // db.syncQueue
  qUpdate: vi.fn(), // db.syncQueue.update (riattivazione dei DELETE failed)
  lockBusy: false, // withNoteLock: lock occupato altrove
  kitProps: [] as any[],
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o ? `${k}|${JSON.stringify(o)}` : k) }) }));
vi.mock('../../../lib/vaultRecovery', async (orig) => ({
  ...(await orig<typeof import('../../../lib/vaultRecovery')>()),
  localRecovery: (...a: unknown[]) => h.localRecovery(...a),
  syncLocalRecovery: (...a: unknown[]) => h.syncLocalRecovery(...a),
  startRecovery: (...a: unknown[]) => h.startRecovery(...a),
  completeRecovery: (...a: unknown[]) => h.completeRecovery(...a),
  openRecoveryContext: (...a: unknown[]) => h.openCtx(...a),
}));
vi.mock('../vaultMigration', () => ({
  finishRotation: (...a: unknown[]) => h.finish(...a),
  rewrapUnreadable: (...a: unknown[]) => h.rewrap(...a),
  MAX_REWRAP_LEN: 1.5 * 1024 * 1024,
}));
vi.mock('../../../lib/db', () => ({
  db: {
    notes: { get: async (id: string) => h.rows.find((r) => r.id === id) },
    syncQueue: { filter: (fn: (i: any) => boolean) => ({ toArray: async () => h.queue.filter(fn) }), update: (...a: unknown[]) => h.qUpdate(...a) },
    transaction: async (...a: unknown[]) => (a[a.length - 1] as () => Promise<unknown>)(),
  },
}));
vi.mock('../StaleNotesDialog', async (orig) => {
  const m = await orig<typeof import('../StaleNotesDialog')>();
  return { ...m, default: (p: any) => { h.dialogProps = p; return m.default(p); } };
});
vi.mock('../../../lib/vaultNoteLock', () => ({ withNoteLock: async (_id: string, fn: () => unknown) => (h.lockBusy ? { status: 'busy' } : { status: 'ran', value: await fn() }) })); // jsdom non ha navigator.locks
vi.mock('../../notes/noteService', () => ({ permanentlyDeleteNote: (...a: unknown[]) => h.permDelete(...a) }));
vi.mock('../../sync/syncService', () => ({ syncPush: (...a: unknown[]) => h.syncPush(...a) }));
vi.mock('react-hot-toast', () => ({ default: { success: (...a: unknown[]) => h.toastOk(...a), error: (...a: unknown[]) => h.toastErr(...a) } }));
vi.mock('../../../lib/vaultApi', async (orig) => ({
  ...(await orig<typeof import('../../../lib/vaultApi')>()),
  getRecovery: (...a: unknown[]) => h.getRecovery(...a),
  getKeyring: (...a: unknown[]) => h.getKeyring(...a),
  cancelRecovery: (...a: unknown[]) => h.cancelRecovery(...a),
}));
vi.mock('../PinPolicy', () => ({ checkPin: (...a: unknown[]) => h.checkPin(...a) }));
vi.mock('../RecoveryCodeForm', () => ({
  default: (p: any) => {
    h.codeProps.push(p);
    return <div data-testid="codeform"><button onClick={p.onChange}>code-change</button><button onClick={p.onCancelAndRedo}>code-redo</button></div>;
  },
}));
vi.mock('../RecoveryKitSheet', () => ({
  default: (p: any) => {
    h.kitProps.push(p);
    return <div data-testid="kit"><button onClick={p.onDone}>kit-done</button></div>;
  },
}));

import VaultRecovery from '../VaultRecovery';
import { VaultRecoveryError } from '../../../lib/vaultRecovery';
import { VaultSessionError } from '../../../lib/vaultSession';
import { VaultApiError } from '../../../lib/vaultApi';
import { appControl } from '../recoveryOutcome';
import { formatKit } from '../../../utils/vaultKit';
import { useAuthStore } from '../../../store/authStore';
import { useVaultStore } from '../../../store/vaultStore';
import { RECOVERY_CHANGED_EVENT, isCeremonyOpen } from '../../../lib/vaultEvents';

const KIT = formatKit(new Uint8Array(20).fill(7));
const rec = (status: string, over: Record<string, unknown> = {}) => ({
  status, fingerprint: 'FP12', notBefore: null, releaseExpiresAt: null, sealedCodeA: null, rootShareForClient: null, rootSignature: null, escrowBlob: null, ...over,
});
const onClose = vi.fn();
const mount = () => render(<VaultRecovery userId="u1" onClose={onClose} />);
const bound = () => h.localRecovery.mockResolvedValue({ requestId: 'r1', fingerprint: 'FP12' });
const L = (k: string) => `vault.recovery.${k}`;
const btn = (name: string) => screen.getByRole('button', { name });
const fillComplete = (kit = KIT, pin = 'k7Rq2x', again = 'k7Rq2x') => {
  fireEvent.change(screen.getByLabelText(L('complete.kit')), { target: { value: kit } });
  fireEvent.change(screen.getByLabelText(L('complete.newPin')), { target: { value: pin } });
  fireEvent.change(screen.getByLabelText('vault.confirmPin'), { target: { value: again } });
};
const submit = () => fireEvent.click(btn(L('complete.submit')));
const toComplete = async () => {
  bound();
  h.getRecovery.mockResolvedValue(rec('RELEASED'));
  mount();
  await screen.findByLabelText(L('complete.kit'));
};

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ user: { id: 'u1', email: 'a@b.it', name: 'A', surname: 'B' } as never });
  useVaultStore.setState({ unlockedUserId: null, keys: null });
  h.codeProps.length = 0;
  h.kitProps.length = 0;
  h.localRecovery.mockResolvedValue(null);
  h.syncLocalRecovery.mockResolvedValue('none');
  h.getKeyring.mockResolvedValue({ status: 'READY', epoch: 0, rev: 1, openRecovery: null });
  h.cancelRecovery.mockResolvedValue({ status: 'CANCELLED' });
  h.checkPin.mockResolvedValue({ ok: true });
  // T11: di default nessuna nota stale (openRecoveryContext -> staleCount 0): il complete parte subito
  h.openCtx.mockReset().mockResolvedValue({ ctx: { keys: {}, userId: 'u1', epoch: 1 }, staleCount: 0 });
  h.finish.mockReset();
  h.rewrap.mockReset();
  h.permDelete.mockReset().mockResolvedValue(undefined);
  h.rows = [];
  h.queue = [];
  h.lockBusy = false;
  h.dialogProps = null;
  h.syncPush.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); cleanup(); });

describe('VaultRecovery: caricamento e intro', () => {
  it('nessuna chiave e nessuna richiesta: intro con avviso "solo il reset"; avvio con motivo -> startRecovery -> status', async () => {
    h.startRecovery.mockResolvedValue({ id: 'r9', fingerprint: 'FP99' });
    h.getRecovery.mockResolvedValue(rec('PENDING_APPROVAL', { fingerprint: 'FP99' }));
    mount();
    expect(await screen.findByText(L('intro.warning'))).toBeTruthy();
    expect(h.getKeyring).toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(L('intro.reasonLabel')), { target: { value: ' perso il telefono ' } });
    fireEvent.click(btn(L('intro.start')));
    await screen.findByText(L('status.pendingApproval'));
    expect(h.startRecovery).toHaveBeenCalledWith('u1', 'perso il telefono');
    expect(h.getRecovery).toHaveBeenCalledWith('r9');
  });

  it('il motivo e limitato a 500 caratteri e assente se vuoto', async () => {
    h.startRecovery.mockResolvedValue({ id: 'r9', fingerprint: 'FP99' });
    h.getRecovery.mockResolvedValue(rec('PENDING_APPROVAL'));
    mount();
    await screen.findByText(L('intro.warning'));
    expect(screen.getByLabelText(L('intro.reasonLabel')).getAttribute('maxlength')).toBe('500');
    fireEvent.click(btn(L('intro.start')));
    await waitFor(() => expect(h.startRecovery).toHaveBeenCalledWith('u1', undefined));
  });

  it('errori di startRecovery: alreadyOpen -> ricarica; 409 recoveryNoKeyring -> testo del server', async () => {
    h.startRecovery.mockRejectedValueOnce(new VaultApiError(409, 'errors.vault.recoveryNoKeyring', 'conflict', true));
    mount();
    await screen.findByText(L('intro.warning'));
    fireEvent.click(btn(L('intro.start')));
    expect((await screen.findByRole('alert')).textContent).toContain('errors.vault.recoveryNoKeyring');
    h.startRecovery.mockRejectedValueOnce(new VaultRecoveryError('alreadyOpen'));
    h.getKeyring.mockClear();
    fireEvent.click(btn(L('intro.start')));
    await waitFor(() => expect(h.getKeyring).toHaveBeenCalledTimes(1));
  });

  it('chiave non legata: syncLocalRecovery active -> status; unknown -> "riprova tra qualche minuto"', async () => {
    h.localRecovery.mockResolvedValueOnce({ requestId: null, fingerprint: 'FP12' }).mockResolvedValue({ requestId: 'r1', fingerprint: 'FP12' });
    h.syncLocalRecovery.mockResolvedValue('active');
    h.getRecovery.mockResolvedValue(rec('WAITING', { notBefore: '2999-01-01T00:00:00.000Z' }));
    mount();
    await screen.findByText(/status\.waiting\|/);
    cleanup();
    h.localRecovery.mockReset().mockResolvedValue({ requestId: null, fingerprint: 'FP12' });
    h.syncLocalRecovery.mockResolvedValue('unknown');
    mount();
    expect((await screen.findByRole('alert')).textContent).toContain(L('errors.retryLater'));
    fireEvent.click(btn(L('actions.retry')));
    await waitFor(() => expect(h.syncLocalRecovery).toHaveBeenCalledTimes(2));
  });

  it('chiave non legata cancellata dalla sync: intro (o foreign se il keyring ha una richiesta aperta)', async () => {
    h.localRecovery.mockResolvedValue({ requestId: null, fingerprint: 'FP12' });
    h.syncLocalRecovery.mockResolvedValue('cleared');
    mount();
    await screen.findByText(L('intro.warning'));
  });

  it('nessuna chiave ma richiesta aperta nel keyring: foreign; "annulla e rifai qui" = cancelRecovery poi startRecovery', async () => {
    h.getKeyring.mockResolvedValue({ status: 'READY', epoch: 0, rev: 1, openRecovery: { id: 'rx', status: 'WAITING', fingerprint: 'FPX', createdAt: 'x', notBefore: null } });
    h.startRecovery.mockResolvedValue({ id: 'r2', fingerprint: 'FP2' });
    h.getRecovery.mockResolvedValue(rec('PENDING_APPROVAL'));
    mount();
    await screen.findByText(L('foreign.title'));
    fireEvent.click(btn(L('actions.cancelAndRedo')));
    expect(h.cancelRecovery).not.toHaveBeenCalled(); // prima il ConfirmDialog
    fireEvent.click(btn(L('redo.confirm')));
    await screen.findByText(L('status.pendingApproval'));
    expect(h.cancelRecovery).toHaveBeenCalledWith('rx');
    expect(h.startRecovery).toHaveBeenCalledWith('u1');
    expect(h.cancelRecovery.mock.invocationCallOrder[0]).toBeLessThan(h.startRecovery.mock.invocationCallOrder[0]);
  });

  it('foreign: "annulla richiesta" annulla e torna all intro', async () => {
    h.getKeyring.mockResolvedValueOnce({ status: 'READY', epoch: 0, rev: 1, openRecovery: { id: 'rx', status: 'WAITING', fingerprint: 'FPX', createdAt: 'x', notBefore: null } });
    mount();
    await screen.findByText(L('foreign.title'));
    fireEvent.click(btn(L('actions.cancelRequest')));
    fireEvent.click(btn(L('cancel.confirm')));
    await screen.findByText(L('intro.warning'));
    expect(h.cancelRecovery).toHaveBeenCalledWith('rx');
    expect(h.startRecovery).not.toHaveBeenCalled();
  });

  it('GET /keyring fallita: errore e "Riprova"', async () => {
    h.getKeyring.mockRejectedValueOnce(new VaultApiError(0, 'errors.common.networkError', 'network'));
    mount();
    expect((await screen.findByRole('alert')).textContent).toContain('errors.common.networkError');
    fireEvent.click(btn(L('actions.retry')));
    await screen.findByText(L('intro.warning'));
  });
});

describe('VaultRecovery: status', () => {
  it('PENDING_APPROVAL: FP e annulla con ConfirmDialog; confermato -> cancelRecovery e intro', async () => {
    bound();
    h.getRecovery.mockResolvedValue(rec('PENDING_APPROVAL'));
    mount();
    expect(await screen.findByText(L('status.pendingApproval'))).toBeTruthy();
    expect(screen.getByText(/status\.fingerprint\|\{"fingerprint":"FP12"\}/)).toBeTruthy();
    fireEvent.click(btn(L('actions.cancelRequest')));
    expect(screen.getByText(L('cancel.message'))).toBeTruthy();
    h.localRecovery.mockResolvedValue(null);
    fireEvent.click(btn(L('cancel.confirm')));
    await screen.findByText(L('intro.warning'));
    expect(h.cancelRecovery).toHaveBeenCalledWith('r1');
    expect(h.syncLocalRecovery).toHaveBeenCalledWith('u1');
  });

  it('pt-1.5 sui ghost solo con un primario sopra: non in PENDING_APPROVAL/WAITING, si in PENDING_CODE', async () => {
    bound();
    h.getRecovery.mockResolvedValue(rec('PENDING_APPROVAL'));
    const first = mount();
    await screen.findByText(L('status.pendingApproval'));
    expect(btn(L('actions.cancelRequest')).parentElement?.className).not.toContain('pt-1.5');
    first.unmount();
    h.getRecovery.mockResolvedValue(rec('WAITING', { notBefore: '2999-01-01T00:00:00.000Z' }));
    const second = mount();
    await screen.findByText(/status\.waiting\|/);
    expect(btn(L('actions.cancelRequest')).parentElement?.className).not.toContain('pt-1.5');
    second.unmount();
    h.getRecovery.mockResolvedValue(rec('PENDING_CODE'));
    mount();
    await screen.findByTestId('codeform');
    expect(btn(L('actions.cancelRequest')).parentElement?.className).toContain('pt-1.5');
  });

  it('annulla e poi "Tienila": nessuna chiamata', async () => {
    bound();
    h.getRecovery.mockResolvedValue(rec('PENDING_APPROVAL'));
    mount();
    await screen.findByText(L('status.pendingApproval'));
    fireEvent.click(btn(L('actions.cancelRequest')));
    fireEvent.click(btn(L('cancel.keep')));
    expect(h.cancelRecovery).not.toHaveBeenCalled();
  });

  it('PENDING_CODE: monta RecoveryCodeForm con FP, tentativi e scadenza; onChange rilegge la richiesta', async () => {
    bound();
    h.getRecovery.mockResolvedValue(rec('PENDING_CODE', { attemptsLeft: 4, expiresAt: '2026-11-20T10:00:00.000Z' }));
    mount();
    await screen.findByTestId('codeform');
    expect(h.codeProps.at(-1)).toMatchObject({ userId: 'u1', requestId: 'r1', fingerprint: 'FP12', attemptsLeft: 4, expiresAt: '2026-11-20T10:00:00.000Z' });
    h.getRecovery.mockResolvedValue(rec('WAITING', { notBefore: '2999-01-01T00:00:00.000Z' }));
    fireEvent.click(btn('code-change'));
    await screen.findByText(/status\.waiting\|/);
    expect(screen.queryByTestId('codeform')).toBeNull();
  });

  it('PENDING_CODE: "annulla e rifai qui" del form (notThisDevice) passa dal ConfirmDialog', async () => {
    bound();
    h.getRecovery.mockResolvedValue(rec('PENDING_CODE'));
    h.startRecovery.mockResolvedValue({ id: 'r2', fingerprint: 'FP2' });
    mount();
    await screen.findByTestId('codeform');
    fireEvent.click(btn('code-redo'));
    fireEvent.click(btn(L('redo.confirm')));
    await waitFor(() => expect(h.startRecovery).toHaveBeenCalledWith('u1'));
    expect(h.cancelRecovery).toHaveBeenCalledWith('r1');
  });

  it('WAITING scaduto: testo waitingDue', async () => {
    bound();
    h.getRecovery.mockResolvedValue(rec('WAITING', { notBefore: '2020-01-01T00:00:00.000Z' }));
    mount();
    expect(await screen.findByText(L('status.waitingDue'))).toBeTruthy();
  });

  it('REJECTED con motivo: testo, "Nuova richiesta" (sync, poi intro) e "Chiudi" (-> sblocco)', async () => {
    bound();
    h.getRecovery.mockResolvedValue(rec('REJECTED', { rejectReason: 'non ti conosco' }));
    mount();
    expect(await screen.findByText(L('status.rejected'))).toBeTruthy();
    expect(screen.getByText(/status\.rejectedReason\|\{"reason":"non ti conosco"\}/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: L('actions.cancelRequest') })).toBeNull();
    fireEvent.click(btn(L('actions.close')));
    expect(onClose).toHaveBeenCalledWith('unlock');
    h.localRecovery.mockResolvedValue(null);
    fireEvent.click(btn(L('actions.newRequest')));
    await screen.findByText(L('intro.warning'));
    expect(h.syncLocalRecovery).toHaveBeenCalledWith('u1');
  });

  it('COMPLETED: azione "vai allo sblocco"', async () => {
    bound();
    h.getRecovery.mockResolvedValue(rec('COMPLETED'));
    mount();
    await screen.findByText(L('status.completed'));
    fireEvent.click(btn(L('actions.goUnlock')));
    expect(onClose).toHaveBeenCalledWith('unlock');
  });

  it('richiesta inesistente (404): richiesta chiusa, nuova richiesta', async () => {
    bound();
    h.getRecovery.mockRejectedValue(new VaultApiError(404, 'errors.vault.recoveryNotFound', 'unknown', true));
    mount();
    expect(await screen.findByText(L('errors.requestClosed'))).toBeTruthy();
    expect(screen.getByRole('button', { name: L('actions.newRequest') })).toBeTruthy();
  });

  it('polling: ogni 60 s, al focus e alla visibilita; si ferma negli stati terminali', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    bound();
    h.getRecovery.mockResolvedValue(rec('PENDING_APPROVAL'));
    mount();
    await screen.findByText(L('status.pendingApproval'));
    const n0 = h.getRecovery.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(h.getRecovery.mock.calls.length).toBe(n0 + 1);
    await act(async () => { window.dispatchEvent(new Event('focus')); await Promise.resolve(); });
    expect(h.getRecovery.mock.calls.length).toBe(n0 + 2);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await Promise.resolve(); });
    expect(h.getRecovery.mock.calls.length).toBe(n0 + 3);
    h.getRecovery.mockResolvedValue(rec('CANCELLED'));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    await screen.findByText(L('status.cancelled'));
    const n1 = h.getRecovery.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
    expect(h.getRecovery.mock.calls.length).toBe(n1);
  });

  it('un poll che legge RELEASED porta al form di completamento', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    bound();
    h.getRecovery.mockResolvedValue(rec('WAITING', { notBefore: '2999-01-01T00:00:00.000Z' }));
    mount();
    await screen.findByText(/status\.waiting\|/);
    expect(screen.queryByLabelText(L('complete.kit'))).toBeNull(); // il form non esiste fuori da RELEASED
    h.getRecovery.mockResolvedValue(rec('RELEASED'));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    await screen.findByLabelText(L('complete.kit'));
  });
});

describe('VaultRecovery: completamento', () => {
  it('il form richiede Kit da 34 simboli e PIN uguale due volte', async () => {
    await toComplete();
    expect((btn(L('complete.submit')) as HTMLButtonElement).disabled).toBe(true);
    fillComplete('ABCD-EFGH', 'k7Rq2x', 'k7Rq2x');
    expect((btn(L('complete.submit')) as HTMLButtonElement).disabled).toBe(true); // Kit corto
    fillComplete(KIT, 'k7Rq2x', '');
    expect((btn(L('complete.submit')) as HTMLButtonElement).disabled).toBe(true);
    fillComplete(KIT, 'k7Rq2x', 'k7Rq2y');
    submit();
    expect((await screen.findByRole('alert')).textContent).toContain('vault.pinMismatch');
    expect(h.completeRecovery).not.toHaveBeenCalled();
  });

  it('PIN rifiutato dalla policy: errore, nessuna POST', async () => {
    await toComplete();
    h.checkPin.mockResolvedValue({ ok: false, reason: 'common' });
    fillComplete();
    submit();
    expect((await screen.findByRole('alert')).textContent).toContain('vault.pinPolicy.common');
    expect(h.completeRecovery).not.toHaveBeenCalled();
    expect(h.checkPin).toHaveBeenCalledWith('k7Rq2x', { name: 'A', surname: 'B', email: 'a@b.it' });
  });

  it('una sola completeRecovery per invio, anche con doppio clic; argomenti giusti', async () => {
    await toComplete();
    let res!: (v: unknown) => void;
    h.completeRecovery.mockReturnValue(new Promise((r) => { res = r; }));
    fillComplete();
    submit();
    submit();
    await waitFor(() => expect(h.completeRecovery).toHaveBeenCalledTimes(1));
    submit();
    expect(h.completeRecovery).toHaveBeenCalledTimes(1);
    expect(h.completeRecovery).toHaveBeenCalledWith({ userId: 'u1', requestId: 'r1', kit: KIT, newPin: 'k7Rq2x' });
    expect(screen.getByText(L('complete.working'))).toBeTruthy();
    await act(async () => { res({ verdict: 'unknown', key: 'x' }); });
  });

  it('applied: foglio del Kit con kit ed escrowHash, poi onClose("none"); il form non esiste piu', async () => {
    await toComplete();
    const kit = new Uint8Array(20).fill(3);
    h.completeRecovery.mockResolvedValue({ verdict: 'applied', kit, escrowHash: 'h-escrow' });
    fillComplete();
    submit();
    await screen.findByTestId('kit');
    expect(h.kitProps.at(-1)).toMatchObject({ kit, userId: 'u1', escrowHash: 'h-escrow' });
    expect(screen.queryByLabelText(L('complete.kit'))).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(btn('kit-done'));
    expect(onClose).toHaveBeenCalledWith('none');
    expect(h.completeRecovery).toHaveBeenCalledTimes(1);
  });

  it('un verdetto smonta il form per sempre: testo e azione unica, nessun secondo invio', async () => {
    await toComplete();
    h.completeRecovery.mockResolvedValue({ verdict: 'completedElsewhere', key: 'x' });
    fillComplete();
    submit();
    expect((await screen.findByRole('alert')).textContent).toContain(L('errors.completedElsewhere'));
    expect(screen.queryByLabelText(L('complete.kit'))).toBeNull();
    expect(screen.queryByRole('button', { name: L('complete.submit') })).toBeNull();
    fireEvent.click(btn(L('actions.goUnlock')));
    expect(onClose).toHaveBeenCalledWith('unlock');
    expect(h.completeRecovery).toHaveBeenCalledTimes(1);
  });

  it('appliedKitReplaced (sempre locked) -> "Vai allo sblocco" -> onClose("unlock")', async () => {
    await toComplete();
    h.completeRecovery.mockResolvedValue({ verdict: 'appliedKitReplaced', locked: true, key: 'x' });
    fillComplete();
    submit();
    await screen.findByText(L('errors.appliedKitReplacedLocked'));
    fireEvent.click(btn(L('actions.goUnlock')));
    expect(onClose).toHaveBeenCalledWith('unlock');
  });

  it('notApplied/keyringChanged -> "Riprova": nuova getRecovery RELEASED e form vuoto', async () => {
    await toComplete();
    h.completeRecovery.mockResolvedValue({ verdict: 'notApplied', reason: 'keyringChanged', key: 'x' });
    fillComplete();
    submit();
    await screen.findByText(L('errors.keyringChanged'));
    h.getRecovery.mockClear();
    fireEvent.click(btn(L('actions.retry')));
    const kit = (await screen.findByLabelText(L('complete.kit'))) as HTMLInputElement;
    expect(h.getRecovery).toHaveBeenCalledTimes(1);
    expect(kit.value).toBe('');
    expect((screen.getByLabelText(L('complete.newPin')) as HTMLInputElement).value).toBe('');
    // il nuovo form (nuovo montaggio) puo inviare di nuovo: e un nuovo giro, non un doppio invio
    h.completeRecovery.mockResolvedValue({ verdict: 'unknown', key: 'x' });
    fillComplete();
    submit();
    await waitFor(() => expect(h.completeRecovery).toHaveBeenCalledTimes(2));
  });

  it('notApplied/requestClosed -> "Nuova richiesta"', async () => {
    await toComplete();
    h.completeRecovery.mockResolvedValue({ verdict: 'notApplied', reason: 'requestClosed', key: 'x' });
    fillComplete();
    submit();
    await screen.findByText(L('errors.requestClosed'));
    h.localRecovery.mockResolvedValue(null);
    fireEvent.click(btn(L('actions.newRequest')));
    await screen.findByText(L('intro.warning'));
  });

  it('errore lanciato (nessuna POST): si resta nel form, si puo reinviare; kitInvalid svuota il Kit', async () => {
    await toComplete();
    h.completeRecovery.mockRejectedValueOnce(new VaultRecoveryError('kitInvalid'));
    fillComplete();
    submit();
    expect((await screen.findByRole('alert')).textContent).toContain(L('errors.kitInvalid'));
    const kit = screen.getByLabelText(L('complete.kit')) as HTMLInputElement;
    expect(kit.value).toBe('');
    h.completeRecovery.mockResolvedValueOnce({ verdict: 'unknown', key: 'x' });
    fillComplete();
    submit();
    await screen.findByText(L('errors.unknown'));
    expect(h.completeRecovery).toHaveBeenCalledTimes(2);
  });

  it('busy: testo e "Riprova" (sul pulsante di invio), nessuna schermata di esito', async () => {
    await toComplete();
    h.completeRecovery.mockRejectedValueOnce(new VaultRecoveryError('busy'));
    fillComplete();
    submit();
    expect((await screen.findByRole('alert')).textContent).toContain(L('errors.busy'));
    expect(screen.getByLabelText(L('complete.kit'))).toBeTruthy();
    h.completeRecovery.mockResolvedValueOnce({ verdict: 'unknown', key: 'x' });
    fireEvent.click(btn(L('actions.retry')));
    await waitFor(() => expect(h.completeRecovery).toHaveBeenCalledTimes(2));
  });

  it('updateRequired: testo, "Aggiorna l app" (nessun annullo) e il form resta', async () => {
    await toComplete();
    const upd = vi.spyOn(appControl, 'update').mockResolvedValue(undefined);
    h.completeRecovery.mockRejectedValueOnce(new VaultRecoveryError('updateRequired'));
    fillComplete();
    submit();
    expect((await screen.findByRole('alert')).textContent).toContain(L('errors.updateRequired'));
    fireEvent.click(btn(L('actions.update')));
    expect(upd).toHaveBeenCalledTimes(1);
    expect(h.cancelRecovery).not.toHaveBeenCalled();
  });

  it('VaultSessionError notReady: sessionChanged e "Ricarica"', async () => {
    await toComplete();
    const rel = vi.spyOn(appControl, 'reload').mockImplementation(() => {});
    h.completeRecovery.mockRejectedValueOnce(new VaultSessionError('notReady', 'errors.vault.notReady'));
    fillComplete();
    submit();
    expect((await screen.findByRole('alert')).textContent).toContain(L('errors.sessionChanged'));
    fireEvent.click(btn(L('actions.reload')));
    expect(rel).toHaveBeenCalledTimes(1);
  });

  it('releaseInvalid: "Annulla e rifai" con ConfirmDialog -> cancelRecovery poi startRecovery', async () => {
    await toComplete();
    h.completeRecovery.mockRejectedValueOnce(new VaultRecoveryError('releaseInvalid'));
    h.startRecovery.mockResolvedValue({ id: 'r2', fingerprint: 'FP2' });
    fillComplete();
    submit();
    await screen.findByText(L('errors.releaseInvalid'));
    fireEvent.click(btn(L('actions.cancelAndRedo')));
    expect(h.cancelRecovery).not.toHaveBeenCalled();
    h.getRecovery.mockResolvedValue(rec('PENDING_APPROVAL'));
    fireEvent.click(btn(L('redo.confirm')));
    await waitFor(() => expect(h.startRecovery).toHaveBeenCalledWith('u1'));
    expect(h.cancelRecovery).toHaveBeenCalledWith('r1');
  });

  it('annullo in RELEASED: il dialogo usa cancelReleasedWarning', async () => {
    await toComplete();
    fireEvent.click(btn(L('actions.cancelRequest')));
    expect(screen.getByText(L('cancelReleasedWarning'))).toBeTruthy();
    expect(screen.queryByText(L('cancel.message'))).toBeNull();
    fireEvent.click(btn(L('cancel.confirm')));
    await waitFor(() => expect(h.cancelRecovery).toHaveBeenCalledWith('r1'));
  });
});

const OPEN_REL = { id: 'rx', status: 'RELEASED', fingerprint: 'FPX', createdAt: 'x', notBefore: null };
const OPEN_WAIT = { ...OPEN_REL, status: 'WAITING' };
const keyringWith = (openRecovery: unknown, status = 'READY') => h.getKeyring.mockResolvedValue({ status, epoch: 0, rev: 1, openRecovery });

describe('VaultRecovery: round di correzioni', () => {
  // 4
  it('form di completamento: "Chiudi" esce senza annullare la richiesta', async () => {
    await toComplete();
    fireEvent.click(btn(L('actions.close')));
    expect(onClose).toHaveBeenCalledWith('unlock');
    expect(h.cancelRecovery).not.toHaveBeenCalled();
  });

  // 5
  it('foreign RELEASED: annullo e "annulla e rifai" usano i testi del rilascio; foreign WAITING no', async () => {
    keyringWith(OPEN_REL);
    mount();
    await screen.findByText(L('foreign.title'));
    fireEvent.click(btn(L('actions.cancelRequest')));
    expect(screen.getByText(L('cancelReleasedWarning'))).toBeTruthy();
    fireEvent.click(btn(L('cancel.keep')));
    fireEvent.click(btn(L('actions.cancelAndRedo')));
    expect(screen.getByText(L('redo.releasedMessage'))).toBeTruthy();
    cleanup();
    keyringWith(OPEN_WAIT);
    mount();
    await screen.findByText(L('foreign.title'));
    fireEvent.click(btn(L('actions.cancelRequest')));
    expect(screen.getByText(L('cancel.message'))).toBeTruthy();
    fireEvent.click(btn(L('cancel.keep')));
    fireEvent.click(btn(L('actions.cancelAndRedo')));
    expect(screen.getByText(L('redo.message'))).toBeTruthy();
  });

  it('releaseInvalid -> "annulla e rifai": testo del rilascio', async () => {
    await toComplete();
    h.completeRecovery.mockRejectedValueOnce(new VaultRecoveryError('releaseInvalid'));
    fillComplete();
    submit();
    await screen.findByText(L('errors.releaseInvalid'));
    fireEvent.click(btn(L('actions.cancelAndRedo')));
    expect(screen.getByText(L('redo.releasedMessage'))).toBeTruthy();
  });

  it('stato ignoto (GET fallita, rec null): annullo prudente con il testo del rilascio', async () => {
    bound();
    h.getRecovery.mockRejectedValue(new VaultApiError(0, 'errors.common.networkError', 'network'));
    mount();
    await screen.findByText(L('status.loadError'));
    fireEvent.click(btn(L('actions.cancelRequest')));
    expect(screen.getByText(L('cancelReleasedWarning'))).toBeTruthy();
  });

  it('un poll porta la richiesta a RELEASED con il dialogo di annullo aperto: il testo si aggiorna', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    bound();
    h.getRecovery.mockResolvedValue(rec('WAITING', { notBefore: '2999-01-01T00:00:00.000Z' }));
    mount();
    await screen.findByText(/status\.waiting\|/);
    fireEvent.click(btn(L('actions.cancelRequest')));
    expect(screen.getByText(L('cancel.message'))).toBeTruthy();
    h.getRecovery.mockResolvedValue(rec('RELEASED'));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    await screen.findByText(L('cancelReleasedWarning'));
    expect(screen.queryByText(L('cancel.message'))).toBeNull();
  });

  it('WAITING, poi un poll fallito: lo stato e ignoto, l annullo usa il testo del rilascio', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    bound();
    h.getRecovery.mockResolvedValue(rec('WAITING', { notBefore: '2999-01-01T00:00:00.000Z' }));
    mount();
    await screen.findByText(/status\.waiting\|/);
    h.getRecovery.mockRejectedValue(new VaultApiError(0, 'errors.common.networkError', 'network'));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    fireEvent.click(btn(L('actions.cancelRequest')));
    expect(screen.getByText(L('cancelReleasedWarning'))).toBeTruthy();
    expect(screen.queryByText(L('cancel.message'))).toBeNull();
  });

  // 6
  it('nessuna chiave e nessuna richiesta, ma vault sbloccato: nessuna intro, "nessuna richiesta aperta" e Chiudi', async () => {
    useVaultStore.setState({ unlockedUserId: 'u1', keys: {} as never });
    mount();
    await screen.findByText(L('noOpenRequest'));
    expect(screen.queryByText(L('intro.warning'))).toBeNull();
    fireEvent.click(btn(L('actions.close')));
    expect(onClose).toHaveBeenCalledWith('unlock');
  });

  it.each(['NONE', 'RESET_PENDING'])('keyring %s da bloccato: nessuna intro', async (status) => {
    keyringWith(null, status);
    mount();
    await screen.findByText(L('noOpenRequest'));
    expect(screen.queryByText(L('intro.warning'))).toBeNull();
  });

  // 7
  it('l esito tiene l FP: "Riprova" (retryFresh) mostra la richiesta con il suo FP', async () => {
    await toComplete();
    h.completeRecovery.mockResolvedValue({ verdict: 'notApplied', reason: 'keyringChanged', key: 'x' });
    fillComplete();
    submit();
    await screen.findByText(L('errors.keyringChanged'));
    h.getRecovery.mockResolvedValue(rec('WAITING', { notBefore: '2999-01-01T00:00:00.000Z' }));
    fireEvent.click(btn(L('actions.retry')));
    await screen.findByText(/status\.waiting\|/);
    expect(screen.getByText(/status\.fingerprint\|\{"fingerprint":"FP12"\}/)).toBeTruthy();
  });

  // 10
  it.each([
    ['409', new VaultApiError(409, 'errors.vault.recoveryStateConflict', 'conflict', true)],
    ['410', new VaultApiError(410, 'errors.vault.recoveryExpired', 'unknown', true)],
    ['rete', new VaultApiError(0, 'errors.common.networkError', 'network')],
  ])('redo: annullo fallito (%s) -> ricarica lo stato, mai startRecovery', async (_n, err) => {
    keyringWith(OPEN_WAIT);
    mount();
    await screen.findByText(L('foreign.title'));
    h.cancelRecovery.mockRejectedValue(err);
    h.getKeyring.mockClear();
    fireEvent.click(btn(L('actions.cancelAndRedo')));
    fireEvent.click(btn(L('redo.confirm')));
    await waitFor(() => expect(h.getKeyring).toHaveBeenCalledTimes(1));
    expect(h.startRecovery).not.toHaveBeenCalled();
  });

  // 11
  it('dalla vista del Kit si esce solo dal foglio: una load() tardiva di un annullo lento non la sostituisce', async () => {
    await toComplete();
    let slow!: () => void;
    h.cancelRecovery.mockReturnValue(new Promise<void>((r) => { slow = () => r(); }));
    fireEvent.click(btn(L('actions.cancelRequest')));
    fireEvent.click(btn(L('cancel.confirm'))); // annullo lento in corso, il dialogo si chiude
    h.completeRecovery.mockResolvedValue({ verdict: 'applied', kit: new Uint8Array(20).fill(3), escrowHash: 'h' });
    fillComplete();
    submit();
    await screen.findByTestId('kit');
    await act(async () => { slow(); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.getByTestId('kit')).toBeTruthy();
    expect(screen.queryByText(L('intro.warning'))).toBeNull();
  });
});

describe('VaultRecovery: banner globale (freschezza)', () => {
  const changed = vi.fn();
  beforeEach(() => { changed.mockClear(); window.addEventListener(RECOVERY_CHANGED_EVENT, changed); });
  afterEach(() => window.removeEventListener(RECOVERY_CHANGED_EVENT, changed));

  it('segnala la cerimonia aperta finche e montata', async () => {
    bound();
    h.getRecovery.mockResolvedValue(rec('PENDING_APPROVAL'));
    const { unmount } = mount();
    expect(isCeremonyOpen()).toBe(true);
    await screen.findByText(L('status.pendingApproval'));
    unmount();
    expect(isCeremonyOpen()).toBe(false);
  });

  it('una lettura con stato diverso dalla precedente emette l evento; uguale no', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    bound();
    h.getRecovery.mockResolvedValue(rec('PENDING_APPROVAL'));
    mount();
    await screen.findByText(L('status.pendingApproval'));
    expect(changed).toHaveBeenCalledTimes(1); // prima lettura: da "sconosciuto" a PENDING_APPROVAL
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(changed).toHaveBeenCalledTimes(1); // stesso stato
    h.getRecovery.mockResolvedValue(rec('WAITING', { notBefore: '2999-01-01T00:00:00.000Z' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    await screen.findByText(/status\.waiting\|/);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('un CompleteResult emette l evento', async () => {
    await toComplete();
    changed.mockClear();
    h.completeRecovery.mockResolvedValue({ verdict: 'applied', kit: new Uint8Array(20).fill(3), escrowHash: 'h' });
    fillComplete();
    submit();
    await screen.findByTestId('kit');
    expect(changed).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------- T11: rotazione della VK prima del complete

describe('VaultRecovery: note stale prima del complete (T11)', () => {
  const CTX = { keys: { vkHkdf: {}, vkAes: {}, sigKey: {} }, userId: 'u1', epoch: 1 } as any;
  const HUGE = 2 * 1024 * 1024; // oltre MAX_REWRAP_LEN
  const it_ = (id: string, reason: 'damaged' | 'keyMissing' | 'unverifiable', size = 10) => ({ id, noteType: 'NOTE', size, reason });
  const rw = (o: Record<string, unknown> = {}) => ({ rewrapped: [], tooLarge: [], readable: [], keyMissing: [], conflicts: [], unverified: [], failed: [], notFound: 0, ...o });
  const fin = (o: Record<string, unknown> = {}) => ({ unreadable: [], tooLarge: [], conflicts: [], failed: [], unverified: [], ...o });
  const migErr = (code: string) => Object.assign(new Error(code), { name: 'MigrationError', code });
  const withStale = (n = 2) => h.openCtx.mockResolvedValue({ ctx: CTX, staleCount: n });
  const goSubmit = async () => { await toComplete(); fillComplete(); submit(); };
  const dialog = () => screen.findByRole('dialog');
  const kitValue = () => (screen.getByLabelText(L('complete.kit')) as HTMLInputElement).value;

  it('(l) staleCount 0: openRecoveryContext poi completeRecovery; finishRotation mai chiamato', async () => {
    h.completeRecovery.mockResolvedValue({ verdict: 'notApplied', reason: 'rejected', key: 'x' });
    await goSubmit();
    await waitFor(() => expect(h.completeRecovery).toHaveBeenCalledTimes(1));
    expect(h.openCtx).toHaveBeenCalledWith({ userId: 'u1', requestId: 'r1', kit: KIT });
    expect(h.openCtx.mock.invocationCallOrder[0]).toBeLessThan(h.completeRecovery.mock.invocationCallOrder[0]);
    expect(h.finish).not.toHaveBeenCalled();
  });

  it('openRecoveryContext null (richiesta non RELEASED): si passa a completeRecovery, che da il verdetto', async () => {
    h.openCtx.mockResolvedValue(null);
    h.completeRecovery.mockResolvedValue({ verdict: 'notApplied', reason: 'requestClosed', key: 'x' });
    await goSubmit();
    await waitFor(() => expect(h.completeRecovery).toHaveBeenCalledTimes(1));
    expect(h.finish).not.toHaveBeenCalled();
  });

  it('errori di openRecoveryContext (kitInvalid): nel form con outcomeOf, nessun complete, nessun dialog', async () => {
    h.openCtx.mockRejectedValue(new VaultRecoveryError('kitInvalid'));
    await goSubmit();
    expect((await screen.findByRole('alert')).textContent).toContain(L('errors.kitInvalid'));
    expect(h.completeRecovery).not.toHaveBeenCalled();
    expect(kitValue()).toBe(''); // clearKit svuota il campo come oggi
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('(m) stale tutte R: finishRotation({ctx, live:false}) PRIMA di completeRecovery', async () => {
    withStale(3);
    h.finish.mockResolvedValue(fin());
    h.completeRecovery.mockResolvedValue({ verdict: 'notApplied', reason: 'rejected', key: 'x' });
    await goSubmit();
    await waitFor(() => expect(h.completeRecovery).toHaveBeenCalledTimes(1));
    expect(h.finish).toHaveBeenCalledTimes(1);
    expect(h.finish).toHaveBeenCalledWith({ ctx: CTX, live: false });
    expect(h.finish.mock.invocationCallOrder[0]).toBeLessThan(h.completeRecovery.mock.invocationCallOrder[0]);
  });

  it('(n) unreadable: dialog visibile, completeRecovery mai chiamato, Kit e PIN conservati', async () => {
    withStale();
    h.finish.mockResolvedValue(fin({ unreadable: [it_('a', 'damaged'), it_('b', 'keyMissing')] }));
    await goSubmit();
    const d = await dialog();
    expect(within(d).getByText(/vault\.rotation\.damaged\|/)).toBeTruthy();
    expect(h.completeRecovery).not.toHaveBeenCalled();
    expect(kitValue()).toBe(KIT);
    expect((screen.getByLabelText(L('complete.newPin')) as HTMLInputElement).value).toBe('k7Rq2x');
  });

  it('(o) conferma: rewrapUnreadable(non tooLarge, ctx, {live:false, allowKeyMissingIds: K+U}), poi finishRotation; residuo vuoto -> dialog chiuso + toast; il nuovo invio arriva al complete', async () => {
    h.openCtx.mockResolvedValueOnce({ ctx: CTX, staleCount: 3 }).mockResolvedValue({ ctx: CTX, staleCount: 0 });
    h.finish.mockResolvedValueOnce(fin({ unreadable: [it_('a', 'damaged'), it_('b', 'keyMissing'), it_('c', 'unverifiable'), it_('big', 'damaged', HUGE)] })).mockResolvedValue(fin());
    h.rewrap.mockResolvedValue(rw({ rewrapped: ['a', 'b', 'c'] }));
    h.completeRecovery.mockResolvedValue({ verdict: 'notApplied', reason: 'rejected', key: 'x' });
    await goSubmit();
    const d = await dialog();
    fireEvent.click(within(d).getByText('vault.rotation.confirmRewrap'));
    await waitFor(() => expect(h.rewrap).toHaveBeenCalledTimes(1));
    expect(h.rewrap).toHaveBeenCalledWith(['a', 'b', 'c'], CTX, { live: false, allowKeyMissingIds: ['b', 'c'] });
    await waitFor(() => expect(h.finish).toHaveBeenCalledTimes(2));
    expect(h.finish).toHaveBeenLastCalledWith({ ctx: CTX, live: false });
    expect(h.rewrap.mock.invocationCallOrder[0]).toBeLessThan(h.finish.mock.invocationCallOrder[1]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.toastOk).toHaveBeenCalledWith(expect.stringContaining('vault.rotation.rewrapDone'));
    expect(h.completeRecovery).not.toHaveBeenCalled(); // nessun avvio automatico
    expect(kitValue()).toBe(KIT);
    submit();
    await waitFor(() => expect(h.completeRecovery).toHaveBeenCalledTimes(1));
    expect(h.openCtx).toHaveBeenCalledTimes(2);
  });

  it('(o) residuo dopo la conferma: il dialog si riapre con le note rimaste e la riga dell esito', async () => {
    withStale();
    h.finish.mockResolvedValueOnce(fin({ unreadable: [it_('a', 'damaged'), it_('k', 'keyMissing', HUGE)] })).mockResolvedValue(fin({ unreadable: [it_('k', 'keyMissing', HUGE)] }));
    h.rewrap.mockResolvedValue(rw({ rewrapped: ['a'] }));
    await goSubmit();
    fireEvent.click(within(await dialog()).getByText('vault.rotation.confirmRewrap'));
    const again = await waitFor(() => { const x = screen.getByRole('dialog'); expect(within(x).getByText(/vault\.rotation\.keyMissingTooLarge\|/)).toBeTruthy(); return x; });
    expect(within(again).getByText(/vault\.rotation\.residue/)).toBeTruthy();
    expect(within(again).queryByText('vault.rotation.confirmRewrap')).toBeNull();
    expect(h.completeRecovery).not.toHaveBeenCalled();
  });

  it('(p) D oltre il limite: permanentlyDeleteNote solo per rw.tooLarge, dopo il ricontrollo con live:false; la K oltre il limite resta e blocca', async () => {
    withStale();
    h.finish.mockResolvedValueOnce(fin({ unreadable: [it_('dbig', 'damaged', HUGE), it_('d2', 'damaged', HUGE), it_('kbig', 'keyMissing', HUGE), it_('ubig', 'unverifiable', HUGE)] }))
      .mockResolvedValue(fin({ unreadable: [it_('kbig', 'keyMissing', HUGE), it_('ubig', 'unverifiable', HUGE)] }));
    h.rewrap.mockResolvedValue(rw({ tooLarge: ['dbig'], readable: ['d2'] })); // d2 non e piu da eliminare al ricontrollo
    await goSubmit();
    const d = await dialog();
    expect(within(d).queryByText('vault.rotation.confirmRewrap')).toBeNull();
    fireEvent.click(within(d).getByText('vault.rotation.deleteTooLarge|{"count":2}'));
    fireEvent.click(await screen.findByText('common.deleteForever'));
    await waitFor(() => expect(h.permDelete).toHaveBeenCalledTimes(1));
    expect(h.permDelete).toHaveBeenCalledWith('dbig');
    expect(h.rewrap).toHaveBeenCalledWith(['dbig', 'd2'], CTX, { live: false });
    expect(h.syncPush).toHaveBeenCalled();
    const again = await waitFor(() => { const x = screen.getByRole('dialog'); expect(within(x).getByText(/vault\.rotation\.keyMissingTooLarge\|/)).toBeTruthy(); return x; });
    expect(within(again).queryByText(/deleteTooLarge/)).toBeNull(); // nessun pulsante per K e U
    expect(h.completeRecovery).not.toHaveBeenCalled();
  });

  it('(p) solo K e U oltre il limite: nessun pulsante di eliminazione ne di conferma, mai permanentlyDeleteNote', async () => {
    withStale();
    h.finish.mockResolvedValue(fin({ unreadable: [it_('kbig', 'keyMissing', HUGE), it_('ubig', 'unverifiable', HUGE)] }));
    await goSubmit();
    const d = await dialog();
    expect(within(d).queryByText(/deleteTooLarge/)).toBeNull();
    expect(within(d).queryByText('vault.rotation.confirmRewrap')).toBeNull();
    expect(h.permDelete).not.toHaveBeenCalled();
    expect(h.rewrap).not.toHaveBeenCalled();
  });

  it('(q) Annulla: il dialog si chiude, resta la riga con il conteggio e l azione che lo riapre; nessuna scrittura', async () => {
    withStale();
    h.finish.mockResolvedValue(fin({ unreadable: [it_('a', 'damaged'), it_('b', 'keyMissing')] }));
    await goSubmit();
    fireEvent.click(within(await dialog()).getByText('common.cancel'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('vault.rotation.banner|{"count":2}')).toBeTruthy();
    fireEvent.click(screen.getByText('vault.rotation.bannerAction'));
    await dialog();
    expect(h.rewrap).not.toHaveBeenCalled();
    expect(h.permDelete).not.toHaveBeenCalled();
    expect(h.completeRecovery).not.toHaveBeenCalled();
  });

  it('prepare true con stale precedente (Annulla poi nuovo invio): riga e dialog spariscono mentre completeRecovery e in volo', async () => {
    h.openCtx.mockResolvedValueOnce({ ctx: CTX, staleCount: 1 }).mockResolvedValue({ ctx: CTX, staleCount: 0 });
    h.finish.mockResolvedValue(fin({ unreadable: [it_('a', 'damaged')] }));
    h.completeRecovery.mockReturnValue(new Promise(() => {})); // mai risolta: il complete resta in volo
    await goSubmit();
    fireEvent.click(within(await dialog()).getByText('common.cancel'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('vault.rotation.banner|{"count":1}')).toBeTruthy();
    submit();
    await waitFor(() => expect(h.completeRecovery).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('vault.rotation.banner|{"count":1}')).toBeNull();
    expect(screen.queryByText('vault.rotation.bannerAction')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('rewrap avviato dal dialog, poi prepare arriva a ready() (nuovo invio): il rewrap tardivo non rimette dialog ne notice', async () => {
    h.openCtx.mockResolvedValueOnce({ ctx: CTX, staleCount: 1 });
    h.finish.mockResolvedValue(fin({ unreadable: [it_('a', 'damaged')] }));
    await goSubmit();
    await dialog();
    let releaseRw!: () => void;
    h.rewrap.mockImplementation(() => new Promise((r) => { releaseRw = () => r(rw({ rewrapped: ['a'] })); }));
    let releaseOpen!: () => void;
    h.openCtx.mockImplementation(() => new Promise((r) => { releaseOpen = () => r({ ctx: CTX, staleCount: 0 }); }));
    h.completeRecovery.mockReturnValue(new Promise(() => {}));
    submit(); // il form non e' ancora bloccato: il rewrap parte dopo, mentre prepare e' in volo
    await waitFor(() => expect(h.openCtx).toHaveBeenCalledTimes(2));
    fireEvent.click(within(await dialog()).getByText('vault.rotation.confirmRewrap'));
    await waitFor(() => expect(h.rewrap).toHaveBeenCalledTimes(1));
    releaseOpen();
    await waitFor(() => expect(h.completeRecovery).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).toBeNull();
    const finishCalls = h.finish.mock.calls.length;
    releaseRw();
    await waitFor(() => expect(h.finish.mock.calls.length).toBe(finishCalls + 1)); // il giro finisce, il risultato si scarta
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/vault\.rotation\.banner/)).toBeNull();
  });

  it('la riga stale non e cliccabile mentre prepare/completeRecovery e in volo', async () => {
    h.openCtx.mockResolvedValueOnce({ ctx: CTX, staleCount: 1 });
    h.finish.mockResolvedValue(fin({ unreadable: [it_('a', 'damaged')] }));
    await goSubmit();
    fireEvent.click(within(await dialog()).getByText('common.cancel'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const action = () => screen.getByText('vault.rotation.bannerAction') as HTMLButtonElement;
    expect(action().disabled).toBe(false);
    let releaseOpen!: () => void;
    h.openCtx.mockImplementation(() => new Promise((r) => { releaseOpen = () => r({ ctx: CTX, staleCount: 1 }); }));
    submit();
    await waitFor(() => expect(h.openCtx).toHaveBeenCalledTimes(2));
    expect(action().disabled).toBe(true);
    fireEvent.click(action());
    expect(screen.queryByRole('dialog')).toBeNull();
    releaseOpen();
    await dialog(); // prepare ha riaperto il dialog: la riga torna cliccabile solo a form libero
  });

  it.each([
    ['epochChanged', 'errors.vault.epochChanged'],
    ['busy', L('errors.busy')],
    ['aborted', 'vault.rotation.finishFailed'],
  ])('(r) finishRotation lancia MigrationError %s: alert corretto, nessun complete', async (code, key) => {
    withStale();
    h.finish.mockRejectedValue(migErr(code));
    await goSubmit();
    expect((await screen.findByRole('alert')).textContent).toContain(key);
    expect(h.completeRecovery).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(kitValue()).toBe(KIT);
  });

  it('(r) finishRotation chiude senza illeggibili ma con un residuo (tooLarge/failed/conflicts): rotationPending, nessun complete', async () => {
    withStale();
    h.finish.mockResolvedValue(fin({ conflicts: ['x'] }));
    await goSubmit();
    expect((await screen.findByRole('alert')).textContent).toContain(L('errors.rotationPending'));
    expect(h.completeRecovery).not.toHaveBeenCalled();
  });

  it('(s) doppia invocazione di conferma prima del flush: un solo rewrapUnreadable', async () => {
    withStale();
    h.finish.mockResolvedValueOnce(fin({ unreadable: [it_('a', 'damaged')] })).mockResolvedValue(fin());
    let release!: () => void;
    h.rewrap.mockImplementation(() => new Promise((r) => { release = () => r(rw({ rewrapped: ['a'] })); }));
    await goSubmit();
    await dialog();
    const p = h.dialogProps; // lo stesso handler due volte nello stesso tick: un clic su un nodo staccato non lo proverebbe
    act(() => { p.onConfirm(); p.onConfirm(); });
    await waitFor(() => expect(h.rewrap).toHaveBeenCalledTimes(1));
    release();
    await waitFor(() => expect(h.finish).toHaveBeenCalledTimes(2));
    expect(h.rewrap).toHaveBeenCalledTimes(1);
  });

  it('(s2) doppia invocazione di Elimina con il ricontrollo pendente: una sola rewrapUnreadable e una sola permanentlyDeleteNote per id', async () => {
    withStale();
    h.finish.mockResolvedValueOnce(fin({ unreadable: [it_('dbig', 'damaged', HUGE)] })).mockResolvedValue(fin());
    let release!: () => void;
    h.rewrap.mockImplementation(() => new Promise((r) => { release = () => r(rw({ tooLarge: ['dbig'] })); }));
    await goSubmit();
    await dialog();
    const p = h.dialogProps;
    act(() => { p.onDeleteDamaged(); p.onDeleteDamaged(); });
    await waitFor(() => expect(h.rewrap).toHaveBeenCalledTimes(1));
    release();
    await waitFor(() => expect(h.permDelete).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(h.finish).toHaveBeenCalledTimes(2));
    expect(h.rewrap).toHaveBeenCalledTimes(1);
    expect(h.permDelete).toHaveBeenCalledTimes(1);
    expect(h.permDelete).toHaveBeenCalledWith('dbig');
  });

  it('(t) il Kit si apre solo con applied; con notApplied/rotationPending (409 dopo la POST) niente Kit e azione di nuova lettura', async () => {
    h.completeRecovery.mockResolvedValue({ verdict: 'notApplied', reason: 'rotationPending', key: L('errors.rotationPending') });
    await goSubmit();
    expect((await screen.findByRole('alert')).textContent).toContain(L('errors.rotationPending'));
    expect(screen.queryByTestId('kit')).toBeNull();
    expect(btn(L('actions.retry'))).toBeTruthy(); // retryFresh
    cleanup();
    h.completeRecovery.mockResolvedValue({ verdict: 'applied', kit: new Uint8Array(20).fill(3), escrowHash: 'h' });
    await goSubmit();
    await screen.findByTestId('kit');
  });

  it('(fix2) D oltre il limite con riga locale non sincronizzata o item in coda: mai eliminata, toast, resta nel dialog; le altre si eliminano', async () => {
    withStale();
    h.rows = [{ id: 'pend', syncStatus: 'updated' }];
    h.queue = [{ entity: 'NOTE', entityId: 'queued' }];
    const big = (id: string) => it_(id, 'damaged', HUGE);
    h.finish.mockResolvedValueOnce(fin({ unreadable: [big('pend'), big('queued'), big('ok')] })).mockResolvedValue(fin({ unreadable: [big('pend'), big('queued')] }));
    h.rewrap.mockResolvedValue(rw({ tooLarge: ['pend', 'queued', 'ok'] }));
    await goSubmit();
    fireEvent.click(within(await dialog()).getByText('vault.rotation.deleteTooLarge|{"count":3}'));
    fireEvent.click(await screen.findByText('common.deleteForever'));
    await waitFor(() => expect(h.permDelete).toHaveBeenCalledTimes(1));
    expect(h.permDelete).toHaveBeenCalledWith('ok');
    expect(h.toastErr).toHaveBeenCalledWith('vault.rotation.deleteSkippedPending|{"count":2}');
    await waitFor(() => expect(h.finish).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(h.dialogProps.items.map((i: any) => i.id).sort()).toEqual(['pend', 'queued']));
  });

  it('(fix6) D con DELETE failed in coda, ancora illeggibile dopo la push: niente toast di eliminazione, avviso, il dialog resta aperto con quell id', async () => {
    withStale();
    h.queue = [{ id: 5, entity: 'NOTE', entityId: 'dbig', type: 'DELETE', status: 'failed' }];
    const big = it_('dbig', 'damaged', HUGE);
    h.finish.mockResolvedValueOnce(fin({ unreadable: [big] })).mockResolvedValue(fin({ unreadable: [big] }));
    h.rewrap.mockResolvedValue(rw({ tooLarge: ['dbig'] }));
    await goSubmit();
    fireEvent.click(within(await dialog()).getByText('vault.rotation.deleteTooLarge|{"count":1}'));
    fireEvent.click(await screen.findByText('common.deleteForever'));
    await waitFor(() => expect(h.finish).toHaveBeenCalledTimes(2));
    expect(h.qUpdate).toHaveBeenCalledWith(5, { status: 'pending', attempts: 0 });
    expect(h.permDelete).not.toHaveBeenCalled(); // la riga e' gia' assente: nessun secondo DELETE
    expect(h.toastErr).toHaveBeenCalledWith('vault.rotation.deletePendingSync|{"count":1}');
    expect(h.toastOk).not.toHaveBeenCalled();
    await waitFor(() => expect(h.dialogProps.items.map((i: any) => i.id)).toEqual(['dbig']));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(h.completeRecovery).not.toHaveBeenCalled();
  });

  it('(fix7) lock occupato altrove: toast "aperta altrove" (non "modifiche non sincronizzate"), nessuna eliminazione', async () => {
    withStale();
    const big = it_('dbig', 'damaged', HUGE);
    h.finish.mockResolvedValueOnce(fin({ unreadable: [big] })).mockResolvedValue(fin({ unreadable: [big] }));
    h.rewrap.mockResolvedValue(rw({ tooLarge: ['dbig'] }));
    await goSubmit();
    fireEvent.click(within(await dialog()).getByText('vault.rotation.deleteTooLarge|{"count":1}'));
    h.lockBusy = true;
    fireEvent.click(await screen.findByText('common.deleteForever'));
    await waitFor(() => expect(h.toastErr).toHaveBeenCalledWith('vault.rotation.deleteSkippedBusy|{"count":1}'));
    expect(h.toastErr).not.toHaveBeenCalledWith(expect.stringContaining('deleteSkippedPending'));
    expect(h.permDelete).not.toHaveBeenCalled();
  });

  it('(fix3) rewrap in volo, poi "Annulla richiesta": il risultato tardivo non fa ricomparire stato stale, notice ne toast', async () => {
    withStale();
    h.finish.mockResolvedValueOnce(fin({ unreadable: [it_('a', 'damaged')] })).mockResolvedValue(fin({ unreadable: [it_('a', 'damaged')], conflicts: ['x'] }));
    let release!: () => void;
    h.rewrap.mockImplementation(() => new Promise((r) => { release = () => r(rw({ rewrapped: ['a'] })); }));
    await goSubmit();
    fireEvent.click(within(await dialog()).getByText('vault.rotation.confirmRewrap'));
    await waitFor(() => expect(h.rewrap).toHaveBeenCalledTimes(1));
    // la richiesta si annulla mentre il rewrap e' in volo: si torna all'intro
    h.localRecovery.mockResolvedValue(null);
    fireEvent.click(btn(L('actions.cancelRequest')));
    fireEvent.click(btn(L('cancel.confirm')));
    await screen.findByText(L('intro.warning'));
    release();
    await waitFor(() => expect(h.finish).toHaveBeenCalledTimes(2)); // il giro finisce comunque, ma il risultato si scarta
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull(); // niente notice rotationPending
    expect(h.toastOk).not.toHaveBeenCalled();
    // una nuova richiesta RELEASED: nessun banner stale con le chiavi vecchie
    h.startRecovery.mockResolvedValue({ id: 'r2', fingerprint: 'FP2' });
    fireEvent.click(btn(L('intro.start')));
    await screen.findByLabelText(L('complete.kit'));
    expect(screen.queryByText(/vault\.rotation\.banner/)).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('(fix5) il submit del form resta disabilitato mentre il dialog lavora (rewrap in volo)', async () => {
    withStale();
    h.finish.mockResolvedValueOnce(fin({ unreadable: [it_('a', 'damaged')] })).mockResolvedValue(fin());
    let release!: () => void;
    h.rewrap.mockImplementation(() => new Promise((r) => { release = () => r(rw({ rewrapped: ['a'] })); }));
    await goSubmit();
    fireEvent.click(within(await dialog()).getByText('vault.rotation.confirmRewrap'));
    await waitFor(() => expect(h.rewrap).toHaveBeenCalledTimes(1));
    expect((btn(L('complete.submit')) as HTMLButtonElement).disabled).toBe(true);
    release();
    await waitFor(() => expect((btn(L('complete.submit')) as HTMLButtonElement).disabled).toBe(false));
  });

  it('(fix6) toast rewrapDone solo senza residuo; prepare azzera il notice precedente', async () => {
    withStale();
    h.finish.mockResolvedValueOnce(fin({ unreadable: [it_('a', 'damaged')] })).mockResolvedValueOnce(fin({ conflicts: ['x'] })).mockResolvedValue(fin());
    h.rewrap.mockResolvedValue(rw({ rewrapped: ['a'] }));
    await goSubmit();
    fireEvent.click(within(await dialog()).getByText('vault.rotation.confirmRewrap'));
    expect((await screen.findByRole('alert')).textContent).toContain(L('errors.rotationPending')); // residuo senza illeggibili: notice
    expect(h.toastOk).not.toHaveBeenCalled(); // con un residuo la rotazione non e' finita: niente "tutto fatto"
    // nuovo invio: il notice precedente sparisce subito, prima della risposta di openRecoveryContext
    let release!: () => void;
    h.openCtx.mockImplementation(() => new Promise((r) => { release = () => r({ ctx: CTX, staleCount: 0 }); }));
    h.completeRecovery.mockResolvedValue({ verdict: 'notApplied', reason: 'rejected', key: 'x' });
    submit();
    await waitFor(() => expect(h.openCtx).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(L('errors.rotationPending'))).toBeNull();
    release();
    await waitFor(() => expect(h.completeRecovery).toHaveBeenCalledTimes(1));
  });

  it('con il dialog stale aperto il Kit non compare e Chiudi esce dalla cerimonia', async () => {
    withStale();
    h.finish.mockResolvedValue(fin({ unreadable: [it_('a', 'damaged')] }));
    await goSubmit();
    await dialog();
    expect(screen.queryByTestId('kit')).toBeNull();
    fireEvent.click(within(screen.getByRole('dialog')).getByText('common.cancel'));
    fireEvent.click(btn(L('actions.close')));
    expect(onClose).toHaveBeenCalledWith('unlock');
  });
});
