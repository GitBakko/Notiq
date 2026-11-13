// Esito della cerimonia di recupero -> testo (chiave i18n) e UNA azione. Tabella: piano Fase 4 §2.
// Niente import runtime di lib/vaultRecovery: gli errori si riconoscono per `name`, cosi' il modulo resta puro e leggero.
import type { CompleteResult, VaultRecoveryCode } from '../../lib/vaultRecovery';

export type OutcomeAction =
  | 'kitCeremony' // applied: foglio del Kit
  | 'regenerateKit' // appliedKitReplaced: VaultSettingsSheet
  | 'goUnlock' // vault gia' deciso altrove o stato ignoto: allo sblocco
  | 'retryFresh' // nulla applicato: nuova lettura della richiesta e form vuoto
  | 'retry' // errore di preparazione: si resta dove si e' e si riprova
  | 'clearKit' // Kit errato: si svuota il campo
  | 'newRequest'
  | 'cancelAndRedo'
  | 'update' // bundle vecchio: registration.update() + reload
  | 'reload'
  | 'backToStatus'
  | 'restart'; // alreadyOpen: si ricarica lo stato

export interface Outcome { key: string; action: OutcomeAction }

const E = 'vault.recovery.errors.';
const UNKNOWN_KEY = 'errors.common.unknownError';

const BY_CODE: Record<VaultRecoveryCode, Outcome> = {
  kitInvalid: { key: `${E}kitInvalid`, action: 'clearKit' },
  releaseInvalid: { key: `${E}releaseInvalid`, action: 'cancelAndRedo' },
  updateRequired: { key: `${E}updateRequired`, action: 'update' },
  notThisDevice: { key: `${E}notThisDevice`, action: 'cancelAndRedo' },
  notReleased: { key: `${E}notReleased`, action: 'backToStatus' },
  busy: { key: `${E}busy`, action: 'retry' },
  keyringChanged: { key: `${E}keyringChanged`, action: 'retry' },
  alreadyOpen: { key: 'errors.vault.recoveryAlreadyOpen', action: 'restart' },
  retryLater: { key: `${E}retryLater`, action: 'retry' },
  requestClosed: { key: `${E}requestClosed`, action: 'newRequest' },
  rejected: { key: `${E}rejected`, action: 'retryFresh' },
  completedElsewhere: { key: `${E}completedElsewhere`, action: 'goUnlock' },
  appliedWithoutKit: { key: `${E}appliedWithoutKit`, action: 'goUnlock' },
  appliedKitReplaced: { key: `${E}appliedKitReplaced`, action: 'regenerateKit' },
  completedUnverified: { key: `${E}completedUnverified`, action: 'goUnlock' },
  unknown: { key: `${E}unknown`, action: 'goUnlock' },
};

const isResult = (x: unknown): x is CompleteResult => !!x && typeof x === 'object' && typeof (x as CompleteResult).verdict === 'string';

function ofResult(r: CompleteResult): Outcome {
  switch (r.verdict) {
    case 'applied': return { key: 'vault.recovery.outcome.applied', action: 'kitCeremony' };
    // keyringChanged dopo la POST: nulla applicato, serve rileggere la richiesta (in preparazione invece basta riprovare)
    case 'notApplied': return r.reason === 'keyringChanged' ? { ...BY_CODE.keyringChanged, action: 'retryFresh' } : BY_CODE[r.reason ?? 'rejected'];
    default: return BY_CODE[r.verdict];
  }
}

export function outcomeOf(x: unknown): Outcome {
  if (isResult(x)) return ofResult(x);
  const e = x as { name?: string; code?: string; key?: unknown; kind?: string } | null;
  if (e?.name === 'VaultRecoveryError' && e.code && e.code in BY_CODE) return BY_CODE[e.code as VaultRecoveryCode];
  if (e?.name === 'VaultSessionError' && e.code === 'notReady') return { key: `${E}sessionChanged`, action: 'reload' };
  const key = typeof e?.key === 'string' && e.key.startsWith('errors.') ? e.key : UNKNOWN_KEY;
  // 409 del server su createRecovery: un'altra richiesta e' aperta, si rilegge lo stato (foreign)
  return { key, action: key === 'errors.vault.recoveryAlreadyOpen' ? 'restart' : 'retry' };
}

/** Azioni sul processo dell'app, in un oggetto per poterle sostituire nei test (window.location.reload non si puo' spiare). */
export const appControl = {
  /** Cerca un service worker nuovo e aspetta che prenda il controllo (max 5 s): serve a prendere un bundle con la chiave root che manca a quello vecchio. */
  async update(): Promise<void> {
    const sw = navigator.serviceWorker;
    try {
      const reg = await sw?.getRegistration();
      await reg?.update();
      // senza un worker nuovo in installazione o in attesa nessun controllerchange arrivera': inutile aspettare
      if (sw && reg && (reg.installing || reg.waiting)) {
        // true = controllerchange: ricarica gia' main.tsx (dopo il syncPush); un secondo reload qui lo taglierebbe
        const taken = await new Promise<boolean>((done) => {
          const end = (v: boolean) => { clearTimeout(timer); sw.removeEventListener('controllerchange', onChange); done(v); };
          const onChange = () => end(true);
          const timer = setTimeout(() => end(false), 5_000);
          sw.addEventListener('controllerchange', onChange);
        });
        if (taken) return;
      }
    } catch { /* si ricarica comunque */ }
    appControl.reload();
  },
  reload(): void { window.location.reload(); },
};
