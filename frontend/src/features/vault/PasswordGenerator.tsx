import { useState, useCallback, useEffect } from 'react';
import { RefreshCw, Copy, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Button';

interface PasswordGeneratorProps {
  onUse: (password: string) => void;
  onClose: () => void;
}

const CHARSETS = {
  uppercase: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lowercase: 'abcdefghijklmnopqrstuvwxyz',
  digits: '0123456789',
  symbols: '!@#$%^&*()_+-=[]{}|;:,.<>?',
};

function generatePassword(length: number, options: { uppercase: boolean; lowercase: boolean; digits: boolean; symbols: boolean }): string {
  let chars = '';
  if (options.uppercase) chars += CHARSETS.uppercase;
  if (options.lowercase) chars += CHARSETS.lowercase;
  if (options.digits) chars += CHARSETS.digits;
  if (options.symbols) chars += CHARSETS.symbols;
  if (!chars) chars = CHARSETS.lowercase + CHARSETS.digits;

  const array = new Uint32Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (v) => chars[v % chars.length]).join('');
}

export default function PasswordGenerator({ onUse, onClose }: PasswordGeneratorProps) {
  const { t } = useTranslation();
  const [length, setLength] = useState(16);
  const [options, setOptions] = useState({ uppercase: true, lowercase: true, digits: true, symbols: true });
  const [password, setPassword] = useState('');
  const [copied, setCopied] = useState(false);

  const regenerate = useCallback(() => {
    setPassword(generatePassword(length, options));
    setCopied(false);
  }, [length, options]);

  useEffect(() => {
    regenerate();
  }, [regenerate]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(password);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const toggleOption = (key: keyof typeof options) => {
    const newOptions = { ...options, [key]: !options[key] };
    // Ensure at least one option is enabled
    if (!newOptions.uppercase && !newOptions.lowercase && !newOptions.digits && !newOptions.symbols) return;
    setOptions(newOptions);
  };

  return (
    <div className="p-4 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-lg w-80 space-y-4">
      <h3 className="font-semibold text-gray-900 dark:text-white text-sm">{t('vault.credential.generator.title')}</h3>

      {/* Preview */}
      <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded-lg font-mono text-sm text-gray-900 dark:text-gray-100 break-all select-all min-h-[3rem]">
        {password}
      </div>

      {/* Length slider */}
      <div className="space-y-1">
        <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400">
          <span>{t('vault.credential.generator.length')}</span>
          <span>{length}</span>
        </div>
        <input
          type="range"
          min={8}
          max={64}
          value={length}
          onChange={(e) => setLength(Number(e.target.value))}
          className="w-full accent-emerald-600"
        />
      </div>

      {/* Options */}
      <div className="space-y-2">
        {(Object.keys(CHARSETS) as Array<keyof typeof CHARSETS>).map((key) => (
          <label key={key} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
            <input
              type="checkbox"
              checked={options[key]}
              onChange={() => toggleOption(key)}
              className="rounded border-gray-300 text-emerald-600 focus:ring-emerald-500 dark:border-gray-600 dark:bg-gray-700"
            />
            {t(`vault.credential.generator.${key}`)}
          </label>
        ))}
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        <Button variant="ghost" size="sm" onClick={regenerate} className="flex-1">
          <RefreshCw size={14} className="mr-1" />
          {t('vault.credential.generator.regenerate')}
        </Button>
        <Button variant="ghost" size="sm" onClick={handleCopy} className="flex-1">
          {copied ? <Check size={14} className="mr-1 text-emerald-500" /> : <Copy size={14} className="mr-1" />}
          {t('vault.credential.generator.copy')}
        </Button>
        <Button variant="primary" size="sm" onClick={() => { onUse(password); onClose(); }} className="flex-1">
          {t('vault.credential.generator.use')}
        </Button>
      </div>
    </div>
  );
}
