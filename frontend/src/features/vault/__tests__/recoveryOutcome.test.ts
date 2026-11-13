import { describe, it, expect, vi, afterEach } from 'vitest';
import en from '../../../locales/en.json';
import it_ from '../../../locales/it.json';
import { VaultRecoveryError, type VaultRecoveryCode, type CompleteResult } from '../../../lib/vaultRecovery';
import { VaultSessionError } from '../../../lib/vaultSession';
import { VaultApiError } from '../../../lib/vaultApi';
import { appControl, outcomeOf, type OutcomeAction } from '../recoveryOutcome';

const has = (loc: unknown, key: string) =>
  typeof key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), loc) === 'string';

type Case = [string, unknown, string, OutcomeAction];
const E = 'vault.recovery.errors.';
const result = (verdict: CompleteResult['verdict'], reason?: CompleteResult['reason'], key?: string) => ({ verdict, reason, key });

const CASES: Case[] = [
  ['applied', result('applied'), 'vault.recovery.outcome.applied', 'kitCeremony'],
  ['appliedKitReplaced', result('appliedKitReplaced'), `${E}appliedKitReplaced`, 'regenerateKit'],
  ['appliedWithoutKit', result('appliedWithoutKit'), `${E}appliedWithoutKit`, 'goUnlock'],
  ['completedElsewhere', result('completedElsewhere'), `${E}completedElsewhere`, 'goUnlock'],
  ['completedUnverified', result('completedUnverified'), `${E}completedUnverified`, 'goUnlock'],
  ['unknown (verdetto)', result('unknown'), `${E}unknown`, 'goUnlock'],
  ['notApplied/keyringChanged', result('notApplied', 'keyringChanged'), `${E}keyringChanged`, 'retryFresh'],
  ['notApplied/rejected', result('notApplied', 'rejected'), `${E}rejected`, 'retryFresh'],
  ['notApplied/requestClosed', result('notApplied', 'requestClosed'), `${E}requestClosed`, 'newRequest'],
];

const CODES: [VaultRecoveryCode, string, OutcomeAction][] = [
  ['kitInvalid', `${E}kitInvalid`, 'clearKit'],
  ['releaseInvalid', `${E}releaseInvalid`, 'cancelAndRedo'],
  ['updateRequired', `${E}updateRequired`, 'update'],
  ['notThisDevice', `${E}notThisDevice`, 'cancelAndRedo'],
  ['notReleased', `${E}notReleased`, 'backToStatus'],
  ['busy', `${E}busy`, 'retry'],
  ['keyringChanged', `${E}keyringChanged`, 'retry'],
  ['alreadyOpen', 'errors.vault.recoveryAlreadyOpen', 'restart'],
  ['retryLater', `${E}retryLater`, 'retry'],
  ['requestClosed', `${E}requestClosed`, 'newRequest'],
  ['rejected', `${E}rejected`, 'retryFresh'],
  ['completedElsewhere', `${E}completedElsewhere`, 'goUnlock'],
  ['appliedWithoutKit', `${E}appliedWithoutKit`, 'goUnlock'],
  ['appliedKitReplaced', `${E}appliedKitReplaced`, 'regenerateKit'],
  ['completedUnverified', `${E}completedUnverified`, 'goUnlock'],
  ['unknown', `${E}unknown`, 'goUnlock'],
];

const ALL: Case[] = [
  ...CASES,
  ...CODES.map(([c, k, a]): Case => [`errore ${c}`, new VaultRecoveryError(c), k, a]),
  ['VaultSessionError notReady', new VaultSessionError('notReady', 'errors.vault.notReady'), `${E}sessionChanged`, 'reload'],
  ['VaultSessionError keyringInvalid', new VaultSessionError('keyringInvalid', 'errors.common.unknownError'), 'errors.common.unknownError', 'retry'],
  ['rete', new VaultApiError(0, 'errors.common.networkError', 'network'), 'errors.common.networkError', 'retry'],
  ['429 del server', new VaultApiError(429, 'errors.vault.recoveryRateLimited', 'rateLimited', true), 'errors.vault.recoveryRateLimited', 'retry'],
  ['409 recoveryAlreadyOpen dal server (VaultApiError)', new VaultApiError(409, 'errors.vault.recoveryAlreadyOpen', 'conflict', true), 'errors.vault.recoveryAlreadyOpen', 'restart'],
  ['errore qualunque', new Error('boom'), 'errors.common.unknownError', 'retry'],
];

describe('outcomeOf', () => {
  it.each(ALL)('%s', (_n, input, key, action) => {
    expect(outcomeOf(input)).toEqual({ key, action });
  });

  it.each(ALL)('%s: la chiave esiste in EN e IT', (_n, input) => {
    const { key } = outcomeOf(input);
    expect(has(en, key)).toBe(true);
    expect(has(it_, key)).toBe(true);
  });

  it('copre ogni VaultRecoveryCode (se ne aggiungi uno, aggiorna la tabella)', () => {
    expect(CODES.map(([c]) => c).sort()).toEqual([
      'alreadyOpen', 'appliedKitReplaced', 'appliedWithoutKit', 'busy', 'completedElsewhere', 'completedUnverified', 'keyringChanged', 'kitInvalid',
      'notReleased', 'notThisDevice', 'rejected', 'releaseInvalid', 'requestClosed', 'retryLater', 'unknown', 'updateRequired',
    ]);
  });

  it('testi richiesti (bozze approvate)', () => {
    expect(en.vault.recovery.errors.updateRequired).toMatch(/Do not cancel the request/);
    expect(it_.vault.recovery.errors.updateRequired).toMatch(/Non annullare la richiesta/);
    expect(en.vault.recovery.errors.releaseInvalid).toMatch(/contact the administrator/);
    expect(it_.vault.recovery.errors.sessionChanged).toBe('La sessione è cambiata. Ricarica la pagina.');
    expect(en.vault.recovery.cancelReleasedWarning).toMatch(/new request, a new approval and a new 72-hour wait/);
    expect(it_.vault.recovery.cancelReleasedWarning).toMatch(/nuova richiesta, una nuova approvazione e altre 72 ore/);
    expect(en.vault.recovery.redo.releasedMessage).toMatch(/only on the device that made it/);
    expect(it_.vault.recovery.redo.releasedMessage).toMatch(/solo sul dispositivo che l'ha fatta/);
    expect(en.vault.recovery.noOpenRequest).toBe('There is no open recovery request.');
    expect(it_.vault.recovery.noOpenRequest).toBe('Non ci sono richieste di recupero aperte.');
    expect(en.vault.pendingPinNotApplied).toMatch(/never reached the server/);
    expect(it_.vault.pendingPinNotApplied).toMatch(/non è mai arrivato al server/);
  });
});

describe('appControl.update', () => {
  type Reg = { update: () => Promise<void>; installing: object | null; waiting: object | null };
  const setSw = (v: unknown) => Object.defineProperty(navigator, 'serviceWorker', { value: v, configurable: true });
  const fakeSw = (reg: Reg | undefined) => Object.assign(new EventTarget(), { getRegistration: async () => reg });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); delete (navigator as { serviceWorker?: unknown }).serviceWorker; });

  it('senza service worker ricarica subito', async () => {
    const reload = vi.spyOn(appControl, 'reload').mockImplementation(() => {});
    await appControl.update();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('con un worker nuovo in installazione aspetta controllerchange e NON ricarica (lo fa main.tsx dopo il syncPush)', async () => {
    const reload = vi.spyOn(appControl, 'reload').mockImplementation(() => {});
    const sw = fakeSw({ update: async () => {}, installing: {}, waiting: null });
    setSw(sw);
    const p = appControl.update();
    await tick();
    expect(reload).not.toHaveBeenCalled();
    sw.dispatchEvent(new Event('controllerchange'));
    await p;
    expect(reload).not.toHaveBeenCalled();
  });

  it('se il nuovo worker non diventa mai controller, ricarica dopo ~5 s', async () => {
    vi.useFakeTimers();
    const reload = vi.spyOn(appControl, 'reload').mockImplementation(() => {});
    setSw(fakeSw({ update: async () => {}, installing: null, waiting: {} }));
    const p = appControl.update();
    await vi.advanceTimersByTimeAsync(4_900);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    await p;
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('nessun worker nuovo (nulla in installazione o in attesa) o nessuna registrazione: ricarica senza attese', async () => {
    const reload = vi.spyOn(appControl, 'reload').mockImplementation(() => {});
    setSw(fakeSw({ update: async () => {}, installing: null, waiting: null }));
    await appControl.update();
    setSw(fakeSw(undefined));
    await appControl.update();
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('update() che lancia: ricarica comunque', async () => {
    const reload = vi.spyOn(appControl, 'reload').mockImplementation(() => {});
    setSw(fakeSw({ update: async () => { throw new Error('offline'); }, installing: null, waiting: null }));
    await appControl.update();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
