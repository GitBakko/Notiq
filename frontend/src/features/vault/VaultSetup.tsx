import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useVaultStore } from '../../store/vaultStore';
import { hashPin } from '../../utils/crypto';
import { Button } from '../../components/ui/Button';
import { Lock, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';

export default function VaultSetup() {
  const { t } = useTranslation();
  const setupVault = useVaultStore(state => state.setupVault);
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [hasAcknowledgedWarning, setHasAcknowledgedWarning] = useState(false);

  const handleSetup = (e: React.FormEvent) => {
    e.preventDefault();
    if (!hasAcknowledgedWarning) {
      toast.error(t('vault.warningConfirm'));
      return;
    }
    if (pin.length < 4) {
      toast.error(t('vault.pinTooShort'));
      return;
    }
    if (pin !== confirmPin) {
      toast.error(t('vault.pinMismatch'));
      return;
    }

    const hashed = hashPin(pin);
    setupVault(hashed, pin);
    toast.success(t('vault.setupSuccess'));
  };

  return (
    <div className="flex flex-col items-center justify-center h-full p-4">
      <div className="bg-white dark:bg-gray-800 p-8 rounded-xl shadow-lg max-w-md w-full text-center border border-gray-200 dark:border-gray-700">
        <div className="bg-emerald-100 dark:bg-emerald-900/30 p-4 rounded-full inline-flex mb-4">
          <Lock size={32} className="text-emerald-600 dark:text-emerald-400" />
        </div>
        <h2 className="text-2xl font-bold mb-2 text-gray-900 dark:text-white">{t('vault.setupTitle')}</h2>
        <p className="text-gray-500 dark:text-gray-400 mb-6">{t('vault.setupDescription')}</p>

        {/* Warning box */}
        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-lg p-4 mb-6 text-left">
          <div className="flex items-start gap-3">
            <AlertTriangle className="text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" size={20} />
            <div>
              <h3 className="font-semibold text-amber-800 dark:text-amber-300 mb-1">{t('vault.warningTitle')}</h3>
              <p className="text-sm text-amber-700 dark:text-amber-400">{t('vault.warningDescription')}</p>
            </div>
          </div>
        </div>

        <form onSubmit={handleSetup} className="space-y-4">
          <input
            type="password"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder={t('vault.enterPin')}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
            autoFocus
          />
          <input
            type="password"
            value={confirmPin}
            onChange={(e) => setConfirmPin(e.target.value)}
            placeholder={t('vault.confirmPin')}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
          />
          
          {/* Acknowledgment checkbox */}
          <label className="flex items-start gap-3 text-left cursor-pointer">
            <input
              type="checkbox"
              checked={hasAcknowledgedWarning}
              onChange={(e) => setHasAcknowledgedWarning(e.target.checked)}
              className="mt-1 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500 dark:border-gray-600 dark:bg-gray-700"
            />
            <span className="text-sm text-gray-600 dark:text-gray-400">
              {t('vault.warningConfirm')}
            </span>
          </label>

          <Button type="submit" variant="primary" className="w-full" disabled={!hasAcknowledgedWarning}>
            {t('vault.setupButton')}
          </Button>
        </form>
      </div>
    </div>
  );
}
