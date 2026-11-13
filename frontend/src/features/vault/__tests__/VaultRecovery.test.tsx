// Vault P4 Fase 4 (T6): macchina a stati di VaultRecovery. Lib, form del codice e foglio del Kit finti; si verifica quale schermata esce e quante chiamate partono.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';

/* eslint-disable @typescript-eslint/no-explicit-any -- mock Vitest */
const h = vi.hoisted(() => ({
  localRecovery: vi.fn(),
  syncLocalRecovery: vi.fn(),
  startRecovery: vi.fn(),
  completeRecovery: vi.fn(),
  getRecovery: vi.fn(),
  getKeyring: vi.fn(),
  cancelRecovery: vi.fn(),
  checkPin: vi.fn(),
  codeProps: [] as any[],
  kitProps: [] as any[],
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o ? `${k}|${JSON.stringify(o)}` : k) }) }));
vi.mock('../../../lib/vaultRecovery', async (orig) => ({
  ...(await orig<typeof import('../../../lib/vaultRecovery')>()),
  localRecovery: (...a: unknown[]) => h.localRecovery(...a),
  syncLocalRecovery: (...a: unknown[]) => h.syncLocalRecovery(...a),
  startRecovery: (...a: unknown[]) => h.startRecovery(...a),
  completeRecovery: (...a: unknown[]) => h.completeRecovery(...a),
}));
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

  it('appliedKitReplaced -> "Rigenera il Kit" -> onClose("regenerate")', async () => {
    await toComplete();
    h.completeRecovery.mockResolvedValue({ verdict: 'appliedKitReplaced', key: 'x' });
    fillComplete();
    submit();
    await screen.findByText(L('errors.appliedKitReplaced'));
    fireEvent.click(btn(L('actions.regenerateKit')));
    expect(onClose).toHaveBeenCalledWith('regenerate');
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
