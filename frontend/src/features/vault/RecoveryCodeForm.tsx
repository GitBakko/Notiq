import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Button';
import { readCodeA } from '../../lib/vaultRecovery';
import * as vaultApi from '../../lib/vaultApi';
import { normalizeKit } from '../../utils/vaultKit';

interface Props {
  userId: string;
  requestId: string;
  fingerprint: string;
  /** Da getRecovery (solo PENDING_CODE); assenti con un server vecchio. */
  attemptsLeft?: number | null;
  expiresAt?: string | null;
  /** Lo stato della richiesta e' cambiato (codici accettati, scaduta, annullata...): il padre rilegge. */
  onChange: () => void;
  /** Codice A non leggibile qui: il padre annulla e rifa la richiesta. */
  onCancelAndRedo: () => void;
}

// Crockford senza I, L, O, U: stessa normalizzazione del Kit.
const HALF = /^[0-9A-HJKMNP-TV-Z]{8}$/;
const INPUT = 'w-full min-h-[44px] px-4 py-2 border border-neutral-300 rounded-lg font-mono uppercase tracking-wider focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 dark:bg-neutral-700 dark:border-neutral-600 dark:text-white';

type Phase = 'loading' | 'ready' | 'notThisDevice' | 'failed';
const isErr = (e: unknown, name: string) => !!e && typeof e === 'object' && (e as { name?: string }).name === name;

/** Inserimento del codice a due meta: A dal dispositivo richiedente, B dall'email. I codici non si loggano mai. */
export default function RecoveryCodeForm({ userId, requestId, fingerprint, attemptsLeft, expiresAt, onChange, onCancelAndRedo }: Props) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>('loading');
  const [codeA, setCodeA] = useState('');
  const [b, setB] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [network, setNetwork] = useState(false);
  const [attempts, setAttempts] = useState<number | null | undefined>(attemptsLeft);
  const sending = useRef(false);
  const alive = useRef(true);
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setAttempts(attemptsLeft); }, [attemptsLeft]);

  const load = useCallback(async () => {
    setPhase('loading');
    try {
      const a = await readCodeA(userId, requestId);
      if (!alive.current) return;
      if (a === null) { setPhase('failed'); onChangeRef.current(); return; } // il padre rilegge; se resta qui, serve almeno "Riprova"
      setCodeA(a);
      setPhase('ready');
    } catch (e) {
      if (!alive.current) return;
      setPhase(isErr(e, 'VaultRecoveryError') && (e as { code?: string }).code === 'notThisDevice' ? 'notThisDevice' : 'failed');
    }
  }, [userId, requestId]);
  useEffect(() => {
    void load();
  }, [load]);

  const nA = normalizeKit(codeA);
  const nB = normalizeKit(b);
  const valid = HALF.test(nA) && HALF.test(nB);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (sending.current || !valid) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    setNetwork(false);
    try {
      await vaultApi.confirmRecovery(requestId, nA, nB);
      onChangeRef.current();
      return;
    } catch (err) {
      if (!alive.current) return;
      const x = err as { name?: string; status?: number; kind?: string; key?: string } | null;
      if (x?.name === 'VaultApiError' && (x.status === 410 || x.status === 409)) { onChangeRef.current(); return; }
      if (x?.name === 'VaultApiError' && x.status === 403 && x.key === 'errors.vault.recoveryInvalidCode') {
        setError('errors.vault.recoveryInvalidCode');
        setB('');
        try {
          const r = await vaultApi.getRecovery(requestId);
          if (!alive.current) return;
          if (r.status !== 'PENDING_CODE') { onChangeRef.current(); return; }
          setAttempts(r.attemptsLeft);
        } catch { /* i tentativi rimasti restano quelli noti */ }
      } else if (x?.name === 'VaultApiError' && x.status === 429) {
        setError('vault.recovery.code.tooMany');
      } else {
        setNetwork(x?.name === 'VaultApiError' && x.kind === 'network');
        setError(typeof x?.key === 'string' && x.key.startsWith('errors.') ? x.key : 'errors.common.unknownError');
      }
    } finally {
      sending.current = false;
      if (alive.current) setBusy(false);
    }
  };

  if (phase === 'loading') return <p role="status" className="text-sm text-neutral-500 dark:text-neutral-400">{t('vault.recovery.loading')}</p>;

  if (phase === 'notThisDevice') {
    return (
      <div className="space-y-4 text-left">
        <p role="status" className="text-sm text-neutral-700 dark:text-neutral-300">{t('vault.recovery.code.notThisDevice', { fingerprint })}</p>
        <Button type="button" variant="primary" className="w-full min-h-[44px]" onClick={onCancelAndRedo}>{t('vault.recovery.actions.cancelAndRedo')}</Button>
      </div>
    );
  }

  if (phase === 'failed') {
    return (
      <div className="space-y-4 text-left">
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">{t('vault.recovery.status.loadError')}</p>
        <Button type="button" variant="secondary" className="w-full min-h-[44px]" onClick={() => { void load(); }}>{t('vault.recovery.actions.retry')}</Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4 text-left">
      <h3 className="text-base font-semibold text-neutral-900 dark:text-white">{t('vault.recovery.code.title')}</h3>
      <p className="text-sm text-neutral-600 dark:text-neutral-400">{t('vault.recovery.code.help')}</p>
      <label className="block">
        <span className="text-xs text-neutral-500 dark:text-neutral-400">{t('vault.recovery.code.halfA')}</span>
        <input type="text" value={codeA} readOnly aria-label={t('vault.recovery.code.halfA')} autoComplete="off" spellCheck={false} className={`${INPUT} bg-neutral-50 dark:bg-neutral-900`} />
      </label>
      <label className="block">
        <span className="text-xs text-neutral-500 dark:text-neutral-400">{t('vault.recovery.code.halfB')}</span>
        <input
          type="text"
          value={b}
          onChange={(ev) => setB(ev.target.value)}
          aria-label={t('vault.recovery.code.halfB')}
          autoComplete="one-time-code"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={b !== '' && !HALF.test(nB)}
          className={INPUT}
          autoFocus
        />
      </label>
      {b !== '' && !HALF.test(nB) && <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('vault.recovery.code.invalidFormat')}</p>}
      {(attempts != null || expiresAt) && (
        <div className="text-xs text-neutral-500 dark:text-neutral-400 space-y-0.5">
          {attempts != null && <p>{t('vault.recovery.code.attemptsLeft', { n: attempts })}</p>}
          {expiresAt && <p>{t('vault.recovery.code.expiresAt', { date: new Date(expiresAt).toLocaleString() })}</p>}
        </div>
      )}
      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{t(error)}</p>}
      <Button type="submit" variant="primary" className="w-full min-h-[44px]" isLoading={busy} disabled={!valid || busy}>
        {network ? t('vault.recovery.actions.retry') : t('vault.recovery.code.submit')}
      </Button>
    </form>
  );
}
