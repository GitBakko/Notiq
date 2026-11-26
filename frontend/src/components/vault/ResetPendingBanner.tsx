import { useEffect } from 'react';
import { ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { useOpenRecovery } from '../../hooks/useOpenRecovery';
import { useCancelReset } from '../../hooks/useCancelReset';
import { useOnline } from '../../hooks/useOnline';
import { RESET_CHANGED_EVENT } from '../../lib/vaultEvents';
import { formatDateTimeMedium } from '../../utils/format';
import { Button } from '../ui/Button';

/**
 * Banner non chiudibile (P3): finche' un reset del vault e' in attesa, ogni sessione lo vede e puo' annullarlo (e' la difesa contro un reset non voluto).
 * Si spegne solo quando il server non riporta piu' `resetScheduledAt`. Compatto: il testo (collegamento a /vault, va a capo e non si tronca) e il solo pulsante "Annulla reset", sulla stessa riga, entrambi da 44px.
 */
export default function ResetPendingBanner() {
  const { t, i18n } = useTranslation();
  const { resetScheduledAt, refresh } = useOpenRecovery();
  const { cancel, busy, error } = useCancelReset();
  const online = useOnline();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  // un reset programmato o annullato altrove nell'app (dialog, schermata del vault): si rilegge subito
  useEffect(() => {
    const on = () => { void refresh(); };
    window.addEventListener(RESET_CHANGED_EVENT, on);
    return () => window.removeEventListener(RESET_CHANGED_EVENT, on);
  }, [refresh]);

  // Su /vault il vault e' bloccato e la schermata del reset in attesa ha gia' titolo, data e "Annulla reset": il banner li duplicherebbe.
  // Gli hook sopra restano attivi, quindi la rilettura periodica (e il blocco del vault) continuano.
  if (!resetScheduledAt || pathname === '/vault' || pathname.startsWith('/vault/')) return null;

  return (
    <div
      role="status"
      className="flex-shrink-0 z-30 flex items-center gap-2 border-b border-red-200 bg-red-50 px-3 py-2 dark:border-red-900/50 dark:bg-red-950/40"
    >
      <ShieldAlert className="h-5 w-5 flex-shrink-0 text-red-600 dark:text-red-400" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        {/* il testo e' il collegamento al vault: va a capo, mai troncato */}
        <button
          type="button"
          onClick={() => navigate('/vault')}
          className="min-h-[44px] w-full break-words py-1 text-left text-sm font-medium text-red-900 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40 dark:text-red-100"
        >
          {t('vault.reset.banner.text', { date: formatDateTimeMedium(resetScheduledAt, i18n.language) })}
        </button>
        {error && <p role="alert" className="text-xs text-red-700 dark:text-red-400">{t(error)}</p>}
      </div>
      <Button variant="secondary" className="min-h-[44px] flex-shrink-0 whitespace-nowrap px-3" disabled={busy || !online} onClick={() => { void cancel(); }}>
        {t('vault.reset.cancel')}
      </Button>
    </div>
  );
}
