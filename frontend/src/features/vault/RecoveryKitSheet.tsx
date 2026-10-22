import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Download, KeyRound } from 'lucide-react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { Button } from '../../components/ui/Button';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { confirmKit } from '../../lib/vaultSession';
import { useVaultStore } from '../../store/vaultStore';
import { buildKitPdf } from '../../utils/kitPdf';
import { formatKit, normalizeKit } from '../../utils/vaultKit';

interface Props {
  /** S_user (20 B), restituito da setup/regenerateKit DOPO la risposta 2xx. Questo componente lo azzera con fill(0). */
  kit: Uint8Array;
  userId: string;
  /** Chiamato dopo la conferma dei 2 gruppi (marker `pending{kit}` cancellato). */
  onDone: () => void;
}

const GROUPS = 8;
const norm = normalizeKit;

/** 2 indici distinti fra gli 8 gruppi, in ordine crescente. */
function pickGroups(): [number, number] {
  const a = Math.floor(Math.random() * GROUPS);
  let b = Math.floor(Math.random() * (GROUPS - 1));
  if (b >= a) b += 1;
  return a < b ? [a, b] : [b, a];
}

/**
 * Cerimonia del Kit (piano 5.4): mostra il Kit, PDF e copia, e chiede di riscrivere 2 gruppi a caso.
 * Non si chiude senza: niente Esc, niente click sullo sfondo. Il Kit vive solo nello stato del componente.
 */
export default function RecoveryKitSheet({ kit, userId, onDone }: Props) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const pdfUrl = useRef<string | null>(null);
  const [formatted] = useState(() => formatKit(kit)); // stringa: serve a vista, copia e PDF anche dopo kit.fill(0)
  const [asked] = useState(pickGroups);
  const [typed, setTyped] = useState<[string, string]>(['', '']);
  const [busy, setBusy] = useState(false);
  useFocusTrap(ref, true);

  const groups = formatted.split('  ')[0].split('-');
  const ok = asked.map((g, i) => norm(typed[i]) === groups[g]);
  const allOk = ok.every(Boolean);

  const revoke = () => {
    if (pdfUrl.current) URL.revokeObjectURL(pdfUrl.current);
    pdfUrl.current = null;
  };
  // Alla chiusura (anche per unmount del padre): niente URL del PDF e niente byte del Kit residui.
  useEffect(() => () => { revoke(); kit.fill(0); }, [kit]);
  // Keep-alive: la cerimonia puo' durare piu' dell'autolock (10 min), che smonterebbe il foglio e azzererebbe il Kit.
  useEffect(() => {
    const id = setInterval(() => useVaultStore.getState().touchVault(), 60_000);
    return () => clearInterval(id);
  }, []);

  const downloadPdf = () => {
    try {
      const pdf = buildKitPdf({
        title: t('vault.kit.pdfTitle'),
        lines: [t('vault.kit.pdfLine1'), t('vault.kit.pdfLine2'), t('vault.kit.pdfLine3')],
        kit: formatted,
        footer: t('vault.kit.pdfFooter'),
      });
      revoke();
      pdfUrl.current = URL.createObjectURL(new Blob([pdf as BlobPart], { type: 'application/pdf' }));
      const a = document.createElement('a');
      a.href = pdfUrl.current;
      a.download = 'notiq-vault-recovery-kit.pdf';
      a.click();
    } catch (e) {
      toast.error(t(e instanceof Error && e.message.startsWith('vault.kit.errors.') ? e.message : 'errors.common.unknownError'));
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(formatted);
      toast.success(t('vault.kit.copied'));
    } catch {
      toast.error(t('vault.kit.copyFailed'));
    }
  };

  const finish = async () => {
    if (!allOk || busy) return;
    setBusy(true);
    try {
      await confirmKit(userId);
    } catch {
      // Il marker pending{kit} sopravvive: restare aperti permette di riprovare invece di dichiarare confermato un Kit che non lo e'.
      toast.error(t('errors.common.unknownError'));
      setBusy(false);
      return;
    }
    revoke();
    kit.fill(0);
    onDone();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 dark:bg-black/70">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="kit-title"
        className="w-full sm:max-w-lg max-h-[90vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl bg-white dark:bg-neutral-800 border border-neutral-200/60 dark:border-neutral-700/40 shadow-xl p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]"
      >
        <div className="mx-auto mb-4 h-1.5 w-10 rounded-full bg-neutral-300 dark:bg-neutral-600 sm:hidden" aria-hidden="true" />
        <div className="flex items-center gap-3 mb-2">
          <div className="bg-emerald-100 dark:bg-emerald-900/30 p-2 rounded-full">
            <KeyRound size={22} className="text-emerald-600 dark:text-emerald-400" />
          </div>
          <h2 id="kit-title" className="text-xl font-bold text-neutral-900 dark:text-white">{t('vault.kit.title')}</h2>
        </div>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">{t('vault.kit.intro')}</p>

        <div
          className="rounded-lg border border-neutral-300 dark:border-neutral-600 bg-neutral-50 dark:bg-neutral-900 p-3 mb-3 text-center font-mono font-bold text-base sm:text-lg tracking-wider break-words select-all text-neutral-900 dark:text-neutral-100"
          aria-label={t('vault.kit.codeLabel')}
        >
          {formatted}
        </div>

        <div className="flex flex-col sm:flex-row gap-2 mb-5">
          <Button type="button" variant="secondary" className="flex-1 min-h-[44px]" onClick={downloadPdf}>
            <Download size={16} className="mr-2" aria-hidden="true" />
            {t('vault.kit.downloadPdf')}
          </Button>
          <Button type="button" variant="secondary" className="flex-1 min-h-[44px]" onClick={copy}>
            <Copy size={16} className="mr-2" aria-hidden="true" />
            {t('vault.kit.copy')}
          </Button>
        </div>

        <p className="text-sm font-medium text-neutral-800 dark:text-neutral-200 mb-1">{t('vault.kit.verifyTitle')}</p>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-3">{t('vault.kit.verifyHelp')}</p>
        <div className="grid grid-cols-2 gap-3 mb-5">
          {asked.map((g, i) => (
            <label key={g} className="block text-left">
              <span className="text-xs text-neutral-500 dark:text-neutral-400">{t('vault.kit.groupN', { n: g + 1 })}</span>
              <div className="relative">
                <input
                  type="text"
                  value={typed[i]}
                  onChange={(e) => setTyped((p) => (i === 0 ? [e.target.value, p[1]] : [p[0], e.target.value]))}
                  maxLength={12}
                  autoComplete="off"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-invalid={typed[i] !== '' && !ok[i]}
                  className={clsx(
                    'w-full min-h-[44px] px-3 pr-9 border rounded-lg font-mono uppercase focus:ring-2 dark:bg-neutral-700 dark:text-white',
                    ok[i]
                      ? 'border-emerald-500 focus:ring-emerald-500 dark:border-emerald-500'
                      : 'border-neutral-300 focus:ring-emerald-500 focus:border-emerald-500 dark:border-neutral-600',
                  )}
                />
                {ok[i] && <Check size={18} className="absolute right-2 top-1/2 -translate-y-1/2 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />}
              </div>
            </label>
          ))}
        </div>

        <Button type="button" variant="primary" className="w-full min-h-[44px]" disabled={!allOk} isLoading={busy} onClick={finish}>
          {t('vault.kit.done')}
        </Button>
      </div>
    </div>
  );
}
