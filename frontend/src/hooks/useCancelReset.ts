import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { cancelReset } from '../lib/vaultApi';
import { RESET_CHANGED_EVENT } from '../lib/vaultEvents';

const errKey = (e: unknown) => {
  const k = (e as { key?: unknown } | null)?.key;
  return typeof k === 'string' && k.startsWith('errors.') ? k : 'errors.common.unknownError';
};

/**
 * Annullo del reset del vault in attesa (P3): basta il JWT. Con o senza successo avvisa il resto dell'app (RESET_CHANGED_EVENT: banner e pagina
 * rileggono il keyring), perche' un 409 vuol dire che lo stato e' gia' cambiato altrove.
 */
export function useCancelReset() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);

  const cancel = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      await cancelReset();
      toast.success(t('vault.reset.cancelledToast'));
    } catch (e) {
      setError(errKey(e));
    } finally {
      running.current = false;
      setBusy(false);
      window.dispatchEvent(new Event(RESET_CHANGED_EVENT));
    }
  }, [t]);

  return { cancel, busy, error };
}
