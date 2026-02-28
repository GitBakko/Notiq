import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { useState, useEffect } from 'react';
import CryptoJS from 'crypto-js';
import { Lock, Unlock, Eye, EyeOff, KeyRound, Save, AlertTriangle, Clock, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { useAuthStore } from '../../store/authStore';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Dialog } from '../ui/Dialog';

const VALIDATION_PREFIX = "NOTIQ-SECURE:";

export default function EncryptedBlockComponent({ node, updateAttributes, deleteNode }: NodeViewProps) {
  const { t } = useTranslation();
  const { user } = useAuthStore();
  const [mode, setMode] = useState<'SETUP' | 'LOCKED' | 'UNLOCKED' | 'WAITING'>('SETUP');
  const [pin, setPin] = useState('');
  const [content, setContent] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [error, setError] = useState('');
  const [isUnlockModalOpen, setIsUnlockModalOpen] = useState(false);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);

  useEffect(() => {
    if (node.attrs.ciphertext) {
      setMode('LOCKED');
    } else {
      if (node.attrs.createdBy && user?.id && node.attrs.createdBy !== user.id) {
        setMode('WAITING');
      } else {
        setMode('SETUP');
      }
    }
  }, [node.attrs.ciphertext, node.attrs.createdBy, user?.id]);

  const handleEncrypt = () => {
    // Check if content is empty - if so, trigger delete flow
    if (!content.trim()) {
      setIsDeleteConfirmOpen(true);
      return;
    }

    if (!pin || pin.length < 4) {
      setError(t('encryption.pinTooShort', 'PIN must be at least 4 characters'));
      return;
    }

    try {
      const dataToEncrypt = VALIDATION_PREFIX + content;
      const ciphertext = CryptoJS.AES.encrypt(dataToEncrypt, pin).toString();
      updateAttributes({ ciphertext });
      setMode('LOCKED');
      setPin('');
      setContent('');
      setError('');
      toast.success(t('encryption.encrypted', 'Content encrypted successfully'));
    } catch (e) {
      console.error(e);
      setError(t('encryption.encryptError', 'Encryption failed'));
    }
  };

  const handleDecrypt = () => {
    if (!pin) return;

    try {
      const bytes = CryptoJS.AES.decrypt(node.attrs.ciphertext, pin);
      const decryptedData = bytes.toString(CryptoJS.enc.Utf8);

      if (decryptedData.startsWith(VALIDATION_PREFIX)) {
        setContent(decryptedData.substring(VALIDATION_PREFIX.length));
        setMode('UNLOCKED');
        setError('');
        setIsUnlockModalOpen(false);
      } else {
        setError(t('encryption.wrongPin', 'Incorrect PIN'));
      }
    } catch (e) {
      console.error(e);
      setError(t('encryption.wrongPin', 'Incorrect PIN'));
    }
  };

  const handleLock = handleEncrypt;

  const handleDeleteConfirm = () => {
    deleteNode();
    setIsDeleteConfirmOpen(false);
  };

  return (
    <NodeViewWrapper className="my-4">
      {/* LOCKED STATE - Minimal */}
      {mode === 'LOCKED' && (
        <div className="flex items-center justify-between p-3 rounded-lg bg-neutral-50 dark:bg-neutral-800/50 border border-neutral-200/60 dark:border-neutral-700/40 group hover:border-emerald-500/50 transition-colors">
          <div className="flex items-center gap-3 text-neutral-500 dark:text-neutral-400">
            <div className="w-8 h-8 rounded-full bg-neutral-200 dark:bg-neutral-700 flex items-center justify-center">
              <Lock size={14} />
            </div>
            <span className="text-sm font-medium">{t('encryption.lockedContent', 'Encrypted Content')}</span>
          </div>
          <button
            onClick={() => setIsUnlockModalOpen(true)}
            className="p-2 rounded-full hover:bg-emerald-50 text-neutral-400 hover:text-emerald-600 transition-colors dark:hover:bg-emerald-900/20 dark:hover:text-emerald-400"
            title={t('common.unlock')}
          >
            <Unlock size={18} />
          </button>
        </div>
      )}

      {/* UNLOCKED STATE - Elegant */}
      {mode === 'UNLOCKED' && (
        <div className="relative rounded-lg border border-emerald-200 bg-emerald-50/30 dark:border-emerald-900/50 dark:bg-emerald-900/10 transition-all">
          <div className="absolute top-0 right-0 p-2 opacity-0 group-hover:opacity-100 transition-opacity">
            <ShieldCheck className="text-emerald-200 dark:text-emerald-800/30 w-12 h-12" />
          </div>

          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="w-full min-h-[100px] p-4 bg-transparent border-none focus:ring-0 resize-y text-neutral-800 dark:text-neutral-200 placeholder-neutral-400"
            placeholder={t('encryption.contentPlaceholder')}
          />

          <div className="flex justify-between items-center p-2 border-t border-emerald-100 dark:border-emerald-900/30 bg-emerald-50/50 dark:bg-emerald-900/20 rounded-b-lg">
            <button
              onClick={() => setIsDeleteConfirmOpen(true)}
              className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-red-500 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors dark:hover:bg-red-900/20"
              title={t('common.delete')}
            >
              <AlertTriangle size={12} />
              {t('common.delete')}
            </button>

            <button
              onClick={handleLock}
              className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:text-emerald-800 hover:bg-emerald-100 rounded-md transition-colors dark:text-emerald-400 dark:hover:text-emerald-300 dark:hover:bg-emerald-900/30"
            >
              <Lock size={12} />
              {t('common.lock', 'Lock')}
            </button>
          </div>
        </div>
      )}

      {/* WAITING STATE */}
      {mode === 'WAITING' && (
        <div className="flex items-center justify-center p-4 rounded-lg border border-dashed border-neutral-300 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800/30 text-neutral-400">
          <div className="flex items-center gap-2 text-sm">
            <Clock size={14} className="animate-pulse" />
            <span>{t('encryption.waiting', 'Encryption in progress...')}</span>
          </div>
        </div>
      )}

      {/* SETUP STATE */}
      {mode === 'SETUP' && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-900/10 overflow-hidden">
          <div className="px-4 py-3 border-b border-blue-100 dark:border-blue-900/30 flex items-center justify-between bg-blue-50/50 dark:bg-blue-900/20">
            <div className="flex items-center gap-2 text-blue-700 dark:text-blue-400 font-medium text-sm">
              <KeyRound size={16} />
              {t('encryption.setup', 'New Encrypted Block')}
            </div>
            <button onClick={() => setIsDeleteConfirmOpen(true)} className="text-blue-400 hover:text-red-500 transition-colors">
              <AlertTriangle size={16} />
            </button>
          </div>

          <div className="p-4 space-y-4">
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={t('encryption.contentPlaceholder', 'Enter confidential content here...')}
              className="w-full min-h-[100px] p-3 rounded-lg border border-blue-200 bg-white dark:border-blue-800 dark:bg-neutral-900 focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none resize-y transition-all"
            />

            <div className="flex items-end gap-3">
              <div className="flex-1">
                <label className="block text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-1.5">
                  {t('encryption.setPin', 'Set Encryption PIN')}
                </label>
                <div className="relative">
                  <input
                    type={showPin ? "text" : "password"}
                    value={pin}
                    onChange={(e) => { setPin(e.target.value); setError(''); }}
                    placeholder={t('editor.pinPlaceholder', 'PIN')}
                    className="w-full px-3 py-2 rounded-lg border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-800 focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-all"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPin(!showPin)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
                  >
                    {showPin ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>
              <Button onClick={handleEncrypt} className="h-[42px] px-6 bg-blue-600 hover:bg-blue-700 text-white">
                <Save size={16} className="mr-2" />
                {t('common.encrypt', 'Encrypt')}
              </Button>
            </div>
            {error && <p className="text-red-500 text-xs mt-1">{error}</p>}
          </div>
        </div>
      )}

      {/* Unlock Modal */}
      <Dialog
        isOpen={isUnlockModalOpen}
        onClose={() => { setIsUnlockModalOpen(false); setPin(''); setError(''); }}
        title={t('encryption.unlockTitle', 'Unlock Content')}
        className="max-w-sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            {t('encryption.enterPinToUnlock', 'Enter the PIN to view this content.')}
          </p>

          <div className="relative">
            <input
              type={showPin ? "text" : "password"}
              value={pin}
              onChange={(e) => { setPin(e.target.value); setError(''); }}
              placeholder={t('editor.pinPlaceholder', 'PIN')}
              className="w-full px-4 py-3 rounded-lg border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-800 focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 outline-none transition-all text-center text-lg tracking-widest"
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && handleDecrypt()}
            />
            <button
              type="button"
              onClick={() => setShowPin(!showPin)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
            >
              {showPin ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>

          {error && <p className="text-red-500 text-sm text-center">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setIsUnlockModalOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleDecrypt} className="bg-emerald-600 hover:bg-emerald-700 text-white">
              {t('common.unlock')}
            </Button>
          </div>
        </div>
      </Dialog>

      <ConfirmDialog
        isOpen={isDeleteConfirmOpen}
        onClose={() => setIsDeleteConfirmOpen(false)}
        onConfirm={handleDeleteConfirm}
        title={t('encryption.deleteTitle', 'Delete Encrypted Block')}
        message={t('encryption.deleteConfirm', 'Are you sure you want to delete this encrypted block? This action cannot be undone.')}
        confirmText={t('common.delete')}
        variant="danger"
      />
    </NodeViewWrapper>
  );
}
