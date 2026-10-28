import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Lock, Plus, X } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { confirmKit, setup, unlockOnline, type RootKeyInfo } from '../../lib/vaultSession';
import type { ReconcileResult } from '../../lib/vaultReconcile';
import { useAuthStore } from '../../store/authStore';
import { useVaultStore } from '../../store/vaultStore';
import { checkPin } from './PinPolicy';
import {
  closeMigration, createLegacyDecryptor, flushPending, migrateLegacy, MigrationError,
  type LegacyDecryptor, type MigrationProgress, type MigrationResult,
} from './vaultMigration';

// Wizard di migrazione dei vault legacy (piano P2 §6). Cerniera fra UI e vaultMigration.ts:
// flush -> setup del keyring (o sblocco col PIN dell'altro dispositivo su 409) -> Kit -> migrazione -> chiusura (reconcile).
// PIN, password e vecchi PIN restano solo nello stato del componente (mai storage); i campi del nuovo PIN si svuotano dopo il setup.

type Phase = 'form' | 'working' | 'unlock' | 'kit' | 'error' | 'done';
type Stage = 'flush' | 'setup' | 'migrate' | 'close';
const CLOSE_TIMEOUT_MS = 30_000;

interface Props {
  userId: string;
  /** true = keyring READY e vault sbloccato (banner "N elementi da aggiornare"): niente flush ne' setup, solo i vecchi PIN. */
  resume?: boolean;
  /** Serve solo al setup: il resume (keyring gia' READY) non lo usa. */
  rootKey?: RootKeyInfo;
  /** Cerimonia del Kit (RecoveryKitSheet, T16). Il wizard chiama confirmKit() e azzera il Kit quando riceve onConfirmed. */
  renderKit: (kit: Uint8Array, onConfirmed: () => void) => ReactNode;
  onDone: () => void;
}

const INPUT = 'w-full min-h-[44px] px-4 py-2 border border-neutral-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 dark:bg-neutral-700 dark:border-neutral-600 dark:text-white disabled:opacity-50';
const errKey = (e: unknown): string => {
  if (e instanceof MigrationError) return `vault.migrate.errors.${e.code}`;
  const k = (e as { key?: unknown } | null)?.key;
  return typeof k === 'string' ? k : 'errors.common.unknownError';
};
const fmt = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function OldPinsFields({ pins, onChange, disabled }: { pins: string[]; onChange: (p: string[]) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  return (
    <fieldset className="space-y-2 text-left" disabled={disabled}>
      <legend className="font-semibold text-neutral-800 dark:text-neutral-200">{t('vault.migrate.oldPinsTitle')}</legend>
      <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('vault.migrate.oldPinsHint')}</p>
      {pins.map((p, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            type="password"
            value={p}
            onChange={(e) => onChange(pins.map((x, j) => (j === i ? e.target.value : x)))}
            aria-label={t('vault.migrate.oldPinLabel', { n: i + 1 })}
            placeholder={t('vault.migrate.oldPinLabel', { n: i + 1 })}
            autoComplete="off"
            className={INPUT}
          />
          {pins.length > 1 && (
            <button
              type="button"
              onClick={() => onChange(pins.filter((_, j) => j !== i))}
              aria-label={t('vault.migrate.removeOldPin', { n: i + 1 })}
              className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-700"
            >
              <X size={18} />
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...pins, ''])}
        className="min-h-[44px] inline-flex items-center gap-2 px-2 text-sm text-emerald-700 hover:text-emerald-800 dark:text-emerald-400 dark:hover:text-emerald-300"
      >
        <Plus size={16} /> {t('vault.migrate.addOldPin')}
      </button>
    </fieldset>
  );
}

export default function VaultMigrate({ userId, resume = false, rootKey, renderKit, onDone }: Props) {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const [phase, setPhase] = useState<Phase>('form');
  const [stage, setStage] = useState<Stage>(resume ? 'migrate' : 'flush');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [password, setPassword] = useState('');
  const [ack, setAck] = useState(false);
  const [oldPins, setOldPins] = useState<string[]>(['']);
  const [formError, setFormError] = useState<string | null>(null);
  const [unlockPin, setUnlockPin] = useState('');
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<Stage>('flush');
  const [progress, setProgress] = useState<MigrationProgress | null>(null);
  const [kit, setKit] = useState<Uint8Array | null>(null);
  const [result, setResult] = useState<MigrationResult | null>(null);
  const [closeRes, setCloseRes] = useState<ReconcileResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const decRef = useRef<LegacyDecryptor | null>(null);
  const kitRef = useRef<Uint8Array | null>(null);
  const submittingRef = useRef(false); // guardia di rientranza di start(): due submit nello stesso tick passano entrambi lo stato React
  const mountedRef = useRef(true);
  kitRef.current = kit;
  const remaining = lockedUntil ? Math.max(0, lockedUntil - now) : 0;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      decRef.current?.terminate();
      kitRef.current?.fill(0);
    };
  }, []);

  useEffect(() => {
    if (!lockedUntil) return;
    const id = setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (n >= lockedUntil) {
        setLockedUntil(null);
        setFormError(null);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [lockedUntil]);

  const pinsList = () => oldPins.filter((p) => p !== '');
  const decryptor = () => (decRef.current ??= createLegacyDecryptor());
  const fail = (s: Stage, e: unknown) => {
    if (e instanceof MigrationError && e.code === 'aborted') return;
    setStage(s);
    setError(errKey(e));
    setPhase('error');
  };

  const runMigrate = async () => {
    setPhase('working');
    setStep('migrate');
    setProgress(null);
    setError(null);
    abortRef.current = new AbortController();
    const { signal } = abortRef.current;
    const vs = useVaultStore.getState();
    const keys = vs.getKeysFor(userId);
    if (!keys || vs.epoch == null) return fail('migrate', new MigrationError('locked'));
    const pins = oldPins.filter((p) => p !== '');
    try {
      const r = await migrateLegacy({
        ctx: { keys, userId, epoch: vs.epoch }, pins, signal, decryptor: decryptor(),
        // il PBKDF2 legacy puo' durare minuti senza input: la barra non deve far scattare l'auto-lock
        onProgress: (p) => { useVaultStore.getState().touchVault(); setProgress(p); },
      });
      setResult(r);
    } catch (e) {
      return fail('migrate', e);
    }
    await runClose();
  };

  const runClose = async () => {
    setPhase('working');
    setStep('close');
    const ac = new AbortController();
    abortRef.current = ac;
    // Annulla e timeout valgono solo finche' il giro ATTENDE il lock (withReconcileLock ignora il signal dopo la concessione).
    // ponytail: nasconderlo a lock ottenuto richiede che withReconcileLock esponga `started` (vaultNoteLock.ts, fuori scope T20).
    const timer = setTimeout(() => ac.abort(), CLOSE_TIMEOUT_MS); // lock di un altro tab/dispositivo mai rilasciato: "riprova"
    try {
      const r = await closeMigration({ pins: pinsList(), signal: ac.signal, decryptor: decryptor() });
      if (r.skipped || r.aborted) return fail('close', new MigrationError(r.skipped === 'busy' ? 'busy' : r.skipped === 'notReady' ? 'notReady' : 'locked'));
      setCloseRes(r);
      setPhase('done');
    } catch (e) {
      // abort (Annulla o timeout) = chiusura non eseguita, non un annullamento silenzioso
      fail('close', e instanceof MigrationError && e.code === 'aborted' ? new MigrationError('busy') : e);
    } finally {
      clearTimeout(timer);
    }
  };

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    try {
      setFormError(null);
      if (resume) return await runMigrate();
      if (!rootKey) return setFormError(t('errors.vault.setupDisabled'));
      if (pin !== pin2) return setFormError(t('vault.pinMismatch'));
      setPhase('working'); // il modulo sparisce subito: niente secondo invio durante checkPin
      setStep('flush');
      setProgress(null);
      let chk: Awaited<ReturnType<typeof checkPin>>;
      try {
        chk = await checkPin(pin, { name: user?.name, surname: user?.surname, email: user?.email });
      } catch (err) {
        // import lazy di pinBlocklist rigettato (bundle vecchio dopo un deploy, chunk non in cache offline): non restare su "working"
        setFormError(t(errKey(err)));
        return setPhase('form');
      }
      if (!chk.ok) {
        setFormError(t(`vault.pinPolicy.${chk.reason}`));
        return setPhase('form');
      }
      abortRef.current = new AbortController();
      try {
        await flushPending(userId, { signal: abortRef.current.signal });
      } catch (err) {
        return fail('flush', err);
      }
      setStep('setup');
      try {
        const r = await setup({ userId, pin, password, rootKey });
        if (!mountedRef.current) {
          // pagina smontata durante il setup: VaultPage ha gia' bloccato il vault e setup() lo ha riaperto -> richiudi, Kit mai mostrato
          if (r.ok) { r.kit.fill(0); void useVaultStore.getState().lockVault(); }
          return;
        }
        if (!r.ok) {
          setPhase('unlock'); // 409: vault gia' creato da un altro dispositivo
          return;
        }
        setPin(''); setPin2(''); setPassword('');
        setKit(r.kit);
        setPhase('kit');
      } catch (err) {
        // password o PIN da correggere: si torna al modulo con il messaggio, i campi restano
        setFormError(t(errKey(err)));
        setPhase('form');
      }
    } finally {
      submittingRef.current = false;
    }
  };

  const onKitConfirmed = async () => {
    await confirmKit(userId).catch(() => {});
    kit?.fill(0);
    setKit(null);
    void runMigrate();
  };

  const submitUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setPhase('working');
    setStep('setup');
    try {
      await unlockOnline(userId, unlockPin);
      setUnlockPin('');
      setPin(''); setPin2(''); setPassword('');
    } catch (err) {
      setUnlockPin('');
      const e = err as { code?: unknown; lockedUntil?: unknown };
      if (e?.code === 'pinLocked' && typeof e.lockedUntil === 'string') {
        const until = Date.parse(e.lockedUntil);
        setNow(Date.now());
        setLockedUntil(Number.isFinite(until) ? until : null);
      }
      setFormError(t(errKey(err)));
      setPhase('unlock');
      return;
    }
    void runMigrate();
  };

  // tooLarge non si risolve riprovando
  const legacyPin = closeRes?.legacyPin ?? 0; // note con riga lasciate dal reconcile perche' serve un PIN precedente (B.13)
  const retryable = result ? result.locked.length + result.conflicts.length + result.unverified.length + result.failed.length + legacyPin : 0;
  const card = 'bg-white dark:bg-neutral-800 p-6 sm:p-8 rounded-xl shadow-lg max-w-md w-full border border-neutral-200/60 dark:border-neutral-700/40';

  return (
    <div className="flex flex-col items-center justify-center h-full p-4 overflow-y-auto">
      <div className={card}>
        <div className="text-center">
          <div className="bg-emerald-100 dark:bg-emerald-900/30 p-4 rounded-full inline-flex mb-4">
            <Lock size={32} className="text-emerald-600 dark:text-emerald-400" />
          </div>
          <h2 className="text-2xl font-bold mb-2 text-neutral-900 dark:text-white">{t('vault.migrate.title')}</h2>
        </div>

        {phase === 'form' && (
          <form onSubmit={start} className="space-y-4">
            <p className="text-neutral-500 dark:text-neutral-400 text-center">{t(resume ? 'vault.migrate.resumeIntro' : 'vault.migrate.intro')}</p>
            {!resume && (
              <>
                <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-lg p-4 text-left">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" size={20} />
                    <p className="text-sm text-amber-700 dark:text-amber-400">{t('vault.migrate.risk')}</p>
                  </div>
                </div>
                <input type="password" value={pin} onChange={(e) => setPin(e.target.value)} placeholder={t('vault.migrate.newPin')} aria-label={t('vault.migrate.newPin')} autoComplete="off" className={INPUT} required />
                <input type="password" value={pin2} onChange={(e) => setPin2(e.target.value)} placeholder={t('vault.confirmPin')} aria-label={t('vault.confirmPin')} autoComplete="off" className={INPUT} required />
                <div>
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t('vault.migrate.password')} aria-label={t('vault.migrate.password')} autoComplete="off" className={INPUT} required />
                  <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{t('vault.migrate.passwordHint')}</p>
                </div>
              </>
            )}
            <OldPinsFields pins={oldPins} onChange={setOldPins} />
            {!resume && (
              <label className="flex items-start gap-3 text-left cursor-pointer min-h-[44px]">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-1 h-5 w-5 rounded border-neutral-300 text-emerald-600 focus:ring-emerald-500 dark:border-neutral-600 dark:bg-neutral-700" />
                <span className="text-sm text-neutral-600 dark:text-neutral-400">{t('vault.migrate.riskAck')}</span>
              </label>
            )}
            {formError && <p role="alert" className="text-sm text-red-600 dark:text-red-400 text-left">{formError}</p>}
            <Button type="submit" variant="primary" className="w-full min-h-[44px]" disabled={!resume && (!ack || !pin || !pin2 || !password)}>
              {t('vault.migrate.start')}
            </Button>
          </form>
        )}

        {phase === 'working' && (
          <div role="status" aria-live="polite" className="space-y-3 text-center">
            <p className="text-neutral-600 dark:text-neutral-300">{t(`vault.migrate.step.${step}`)}</p>
            {progress && progress.total > 0 && (
              <>
                <div role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done} className="h-2 w-full rounded-full bg-neutral-200 dark:bg-neutral-700 overflow-hidden">
                  <div className="h-full bg-emerald-500 dark:bg-emerald-400 transition-transform origin-left" style={{ transform: `scaleX(${progress.done / progress.total})` }} />
                </div>
                <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('vault.migrate.progress', { done: progress.done, total: progress.total })}</p>
              </>
            )}
            <div className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
            {step === 'close' && (
              <Button variant="secondary" className="w-full min-h-[44px]" aria-label={t('common.cancel')} onClick={() => abortRef.current?.abort()}>
                {t('common.cancel')}
              </Button>
            )}
          </div>
        )}

        {phase === 'unlock' && (
          <form onSubmit={submitUnlock} className="space-y-4">
            <p className="text-neutral-500 dark:text-neutral-400 text-center">{t('vault.migrate.unlockHint')}</p>
            <input type="password" value={unlockPin} onChange={(e) => setUnlockPin(e.target.value)} placeholder={t('vault.enterPin')} aria-label={t('vault.enterPin')} autoComplete="off" className={INPUT} autoFocus required disabled={remaining > 0} />
            {remaining > 0 ? (
              <p role="status" className="text-sm text-amber-700 dark:text-amber-400">{t('vault.unlock.lockedFor', { time: fmt(remaining) })}</p>
            ) : formError && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{formError}</p>}
            <Button type="submit" variant="primary" className="w-full min-h-[44px]" disabled={!unlockPin || remaining > 0}>{t('vault.migrate.unlockButton')}</Button>
            <Button type="button" variant="secondary" className="w-full min-h-[44px]" onClick={onDone}>{t('common.cancel')}</Button>
          </form>
        )}

        {phase === 'kit' && kit && renderKit(kit, onKitConfirmed)}

        {phase === 'error' && (
          <div className="space-y-4 text-center">
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error ? t(error) : ''}</p>
            <Button
              variant="primary"
              className="w-full min-h-[44px]"
              onClick={() => (stage === 'close' ? void runClose() : stage === 'flush' ? setPhase('form') : void runMigrate())}
            >
              {t('vault.migrate.retry')}
            </Button>
          </div>
        )}

        {phase === 'done' && result && (
          <div className="space-y-4 text-left">
            <p role="status" className="text-neutral-700 dark:text-neutral-200 text-center">
              {result.migrated === 0 && (closeRes?.legacyResolved ?? 0) > 0
                ? t('vault.migrate.localResolved', { n: closeRes?.legacyResolved })
                : t('vault.migrate.doneSummary', { n: result.migrated })}
            </p>
            {(closeRes?.copies ?? 0) > 0 && <p className="text-sm text-amber-700 dark:text-amber-400">{t('vault.migrate.copiesCreated', { n: closeRes?.copies })}</p>}
            {result.tooLarge.length > 0 && <p className="text-sm text-amber-700 dark:text-amber-400">{t('vault.migrateTooLarge', { n: result.tooLarge.length })}</p>}
            {result.withAttachments > 0 && <p className="text-sm text-amber-700 dark:text-amber-400">{t('vault.migrate.attachmentsNotice', { n: result.withAttachments })}</p>}
            {(result.conflicts.length > 0 || result.unverified.length > 0 || result.failed.length > 0) && (
              <p className="text-sm text-amber-700 dark:text-amber-400">{t('vault.migrate.notVerified', { n: result.conflicts.length + result.unverified.length + result.failed.length })}</p>
            )}
            {(result.locked.length > 0 || legacyPin > 0) && (
              <>
                {result.locked.length > 0 && <p className="text-sm text-amber-700 dark:text-amber-400">{t('vault.migrate.lockedSummary', { n: result.locked.length })}</p>}
                {legacyPin > 0 && <p className="text-sm text-amber-700 dark:text-amber-400">{t('vault.migrate.localLocked', { n: legacyPin })}</p>}
                <OldPinsFields pins={oldPins} onChange={setOldPins} />
              </>
            )}
            {retryable > 0 && (
              <Button variant="primary" className="w-full min-h-[44px]" onClick={() => void runMigrate()}>{t('vault.migrate.retry')}</Button>
            )}
            <Button variant={retryable > 0 ? 'secondary' : 'primary'} className="w-full min-h-[44px]" onClick={onDone}>{t('vault.migrate.finish')}</Button>
          </div>
        )}
      </div>
    </div>
  );
}
