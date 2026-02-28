import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useVaultStore } from '../../store/vaultStore';
import { hashPin } from '../../utils/crypto';
import { Button } from '../../components/ui/Button';
import { Lock, Unlock, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';

export default function VaultUnlock() {
  const { t } = useTranslation();
  const { pinHash, unlockVault, resetVault } = useVaultStore();
  const [pin, setPin] = useState('');
  const [showResetDialog, setShowResetDialog] = useState(false);
  const [resetConfirmation, setResetConfirmation] = useState('');

  const handleUnlock = (e: React.FormEvent) => {
    e.preventDefault();
    const hashed = hashPin(pin);
    if (hashed === pinHash) {
      unlockVault(pin);
      toast.success(t('vault.unlocked'));
    } else {
      toast.error(t('vault.incorrectPin'));
      setPin('');
    }
  };

  const handleReset = () => {
    if (resetConfirmation.toUpperCase() === 'DELETE') {
      resetVault();
      toast.success(t('vault.resetVaultSuccess'));
      setShowResetDialog(false);
      setResetConfirmation('');
    }
  };

  if (showResetDialog) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-4">
        <div className="bg-white dark:bg-neutral-800 p-8 rounded-xl shadow-lg max-w-md w-full text-center border border-neutral-200/60 dark:border-neutral-700/40">
          <div className="bg-red-100 dark:bg-red-900/30 p-4 rounded-full inline-flex mb-4">
            <AlertTriangle size={32} className="text-red-600 dark:text-red-400" />
          </div>
          <h2 className="text-2xl font-bold mb-2 text-neutral-900 dark:text-white">{t('vault.resetVaultTitle')}</h2>
          <p className="text-neutral-500 dark:text-neutral-400 mb-4">{t('vault.resetVaultDescription')}</p>
          
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded-lg p-4 mb-6 text-left">
            <p className="text-sm text-red-700 dark:text-red-400 font-medium">{t('vault.resetVaultWarning')}</p>
          </div>

          <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">{t('vault.resetVaultConfirm')}</p>
          
          <input
            type="text"
            value={resetConfirmation}
            onChange={(e) => setResetConfirmation(e.target.value)}
            placeholder={t('vault.resetVaultPlaceholder')}
            className="w-full px-4 py-2 border border-neutral-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-500 dark:bg-neutral-700 dark:border-neutral-600 dark:text-white mb-4"
            autoFocus
          />

          <div className="flex gap-3">
            <Button 
              type="button" 
              variant="secondary" 
              className="flex-1"
              onClick={() => {
                setShowResetDialog(false);
                setResetConfirmation('');
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button 
              type="button" 
              variant="danger" 
              className="flex-1"
              disabled={resetConfirmation.toUpperCase() !== 'DELETE'}
              onClick={handleReset}
            >
              {t('vault.resetVaultButton')}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center h-full p-4">
      <div className="bg-white dark:bg-neutral-800 p-8 rounded-xl shadow-lg max-w-md w-full text-center border border-neutral-200/60 dark:border-neutral-700/40">
        <div className="bg-neutral-100 dark:bg-neutral-700 p-4 rounded-full inline-flex mb-4">
          <Lock size={32} className="text-neutral-600 dark:text-neutral-400" />
        </div>
        <h2 className="text-2xl font-bold mb-2 text-neutral-900 dark:text-white">{t('vault.lockedTitle')}</h2>
        <p className="text-neutral-500 dark:text-neutral-400 mb-6">{t('vault.lockedDescription')}</p>

        <form onSubmit={handleUnlock} className="space-y-4">
          <input type="text" autoComplete="username" className="hidden" tabIndex={-1} aria-hidden="true" />
          <input
            type="password"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder={t('vault.enterPin')}
            autoComplete="current-password"
            className="w-full px-4 py-2 border border-neutral-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 dark:bg-neutral-700 dark:border-neutral-600 dark:text-white"
            autoFocus
          />
          <Button type="submit" variant="primary" className="w-full">
            <Unlock size={18} className="mr-2" />
            {t('vault.unlockButton')}
          </Button>
        </form>

        <button
          onClick={() => setShowResetDialog(true)}
          className="mt-4 text-sm text-neutral-500 hover:text-red-600 dark:text-neutral-400 dark:hover:text-red-400 transition-colors"
        >
          {t('vault.forgotPin')}
        </button>
      </div>
    </div>
  );
}
