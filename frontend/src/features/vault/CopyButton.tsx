import { useState, useCallback, useRef } from 'react';
import { Copy, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';

interface CopyButtonProps {
  value: string;
  label?: string;
  className?: string;
}

const CLIPBOARD_CLEAR_MS = 30_000;

export default function CopyButton({ value, label, className = '' }: CopyButtonProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);

      // Auto-clear clipboard after 30s
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
      clearTimerRef.current = setTimeout(async () => {
        try {
          await navigator.clipboard.writeText('');
          toast(t('vault.credential.clipboardCleared'), { icon: '🔒' });
        } catch {
          // clipboard API may fail if page loses focus
        }
      }, CLIPBOARD_CLEAR_MS);
    } catch {
      // Fallback: older browsers
    }
  }, [value, t]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`p-1.5 rounded-lg text-neutral-500 hover:text-neutral-700 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:text-neutral-200 dark:hover:bg-neutral-700 transition-colors ${className}`}
      title={label || t('vault.credential.copied')}
    >
      {copied ? <Check size={16} className="text-emerald-500" /> : <Copy size={16} />}
    </button>
  );
}
