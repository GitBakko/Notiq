import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, WifiOff } from 'lucide-react';
import toast from 'react-hot-toast';
import Modal from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { confirmReset, resetChallenge, type ResetChallenge } from '../../lib/vaultApi';
import { RESET_CHANGED_EVENT } from '../../lib/vaultEvents';
import { useOnline } from '../../hooks/useOnline';
import { formatDateTimeMedium } from '../../utils/format';
import { normalizeResetCode } from './resetCode';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** Reset programmato (200 di POST /vault/reset): `scheduledAt` e' la data della cancellazione definitiva. */
  onScheduled?: (scheduledAt: string) => void;
}

const CODE_LEN = 12;
const INPUT =
  'w-full min-h-[44px] px-4 py-2 text-base border border-neutral-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-500 dark:bg-neutral-700 dark:border-neutral-600 dark:text-white';

const groups = (code: string) => normalizeResetCode(code).match(/.{1,4}/g)?.join('-') ?? '';

const errKey = (e: unknown) => {
  const k = (e as { key?: unknown } | null)?.key;
  return typeof k === 'string' && k.startsWith('errors.') ? k : 'errors.common.unknownError';
};

// Il codice non e' piu' utilizzabile (scaduto, tentativi finiti) o la richiesta e' cambiata: serve una nuova challenge.
const NEEDS_NEW_CHALLENGE = ['errors.vault.resetExpired', 'errors.vault.resetStateConflict'];

/**
 * Reset del vault (P3): l'unica uscita da PIN e Kit persi. Distrugge tutto il contenuto del vault, ma solo dopo 7 giorni e con annullo possibile.
 * Passo 1: avviso e richiesta del codice (challenge). Passo 2: conteggi, codice da riscrivere (stile GitHub) e password dell'account; poi un ConfirmDialog finale.
 * La password vive solo nello stato del componente e si svuota prima della chiamata.
 * Montato solo da aperto (lo stato si azzera alla chiusura): il wrapper smonta il contenuto.
 */
export default function VaultResetDialog(props: Props) {
  return props.isOpen ? <ResetDialog {...props} /> : null;
}

function ResetDialog({ onClose, onScheduled }: Props) {
  const { t, i18n } = useTranslation();
  const online = useOnline();
  const [step, setStep] = useState<'intro' | 'code'>('intro');
  const [challenge, setChallenge] = useState<ResetChallenge | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const running = useRef(false); // doppio invio nello stesso tick: `busy` (stato) non fa in tempo

  const codeOk = !!challenge && normalizeResetCode(code).length === CODE_LEN && normalizeResetCode(code) === normalizeResetCode(challenge.code);
  const canSubmit = codeOk && password !== '' && online && !busy;

  const start = async () => {
    if (running.current || !online) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      setChallenge(await resetChallenge());
      setCode('');
      setPassword('');
      setStep('code');
    } catch (e) {
      setError(errKey(e));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  const doConfirm = async () => {
    if (running.current || !challenge || !canSubmit) return;
    running.current = true;
    setBusy(true);
    setError(null);
    const pw = password;
    setPassword(''); // la password lascia lo stato prima dell'await
    try {
      const r = await confirmReset(challenge.requestId, normalizeResetCode(code), pw);
      toast.success(t('vault.reset.scheduledToast', { date: formatDateTimeMedium(r.scheduledAt, i18n.language) }));
      window.dispatchEvent(new Event(RESET_CHANGED_EVENT));
      onScheduled?.(r.scheduledAt);
      onClose();
    } catch (e) {
      const key = errKey(e);
      setError(key);
      if (NEEDS_NEW_CHALLENGE.includes(key)) { setStep('intro'); setChallenge(null); setCode(''); }
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  const err = error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{t(error)}</p>;
  const close = () => { if (!busy) onClose(); };

  return (
    <>
      <Modal isOpen={!confirming} onClose={close} title={t('vault.reset.title')} size="lg" sheet>
        {step === 'intro' ? (
          <div className="space-y-4 text-left text-sm text-neutral-700 dark:text-neutral-300">
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
              <AlertTriangle size={18} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
              <p>{t('vault.reset.intro')}</p>
            </div>
            <p>{t('vault.reset.waitNote')}</p>
            <p>{t('vault.reset.offlineLoss')}</p>
            {!online && (
              <p role="status" className="flex items-start gap-2 text-neutral-700 dark:text-neutral-300">
                <WifiOff size={18} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
                <span>{t('vault.reset.offline')}</span>
              </p>
            )}
            {err}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="ghost" className="min-h-[44px]" onClick={close} disabled={busy}>{t('common.cancel')}</Button>
              <Button type="button" variant="danger" className="min-h-[44px]" onClick={() => { void start(); }} isLoading={busy} disabled={!online || busy}>
                {t('vault.reset.start')}
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); if (canSubmit) setConfirming(true); }} className="space-y-4 text-left text-sm text-neutral-700 dark:text-neutral-300">
            <p>{t('vault.reset.counts', { notes: challenge?.counts.notes ?? 0, tags: challenge?.counts.tags ?? 0, attachments: challenge?.counts.attachments ?? 0 })}</p>
            <div>
              <p>{t('vault.reset.codeIntro')}</p>
              <p className="mt-2 select-all break-all rounded-lg bg-neutral-100 px-3 py-2 text-center font-mono text-lg tracking-wider text-neutral-900 dark:bg-neutral-800 dark:text-white">
                {groups(challenge?.code ?? '')}
              </p>
            </div>
            <div className="space-y-1">
              <label htmlFor="vault-reset-code" className="block font-medium">{t('vault.reset.codeLabel')}</label>
              <input
                id="vault-reset-code"
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="off"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                className={`${INPUT} font-mono uppercase`}
              />
              <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('vault.reset.codeHint')}</p>
            </div>
            <div className="space-y-1">
              <label htmlFor="vault-reset-password" className="block font-medium">{t('vault.reset.passwordLabel')}</label>
              <input
                id="vault-reset-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                className={INPUT}
              />
            </div>
            <p>{t('vault.reset.offlineLoss')}</p>
            {!online && (
              <p role="status" className="flex items-start gap-2">
                <WifiOff size={18} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
                <span>{t('vault.reset.offline')}</span>
              </p>
            )}
            {err}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="ghost" className="min-h-[44px]" onClick={close} disabled={busy}>{t('common.cancel')}</Button>
              <Button type="submit" variant="danger" className="min-h-[44px]" isLoading={busy} disabled={!canSubmit}>{t('vault.reset.submit')}</Button>
            </div>
          </form>
        )}
      </Modal>
      <ConfirmDialog
        isOpen={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => { void doConfirm(); }}
        title={t('vault.reset.confirmTitle')}
        message={t('vault.reset.confirmMessage')}
        confirmText={t('vault.reset.confirmAction')}
        cancelText={t('common.cancel')}
        variant="danger"
      />
    </>
  );
}
