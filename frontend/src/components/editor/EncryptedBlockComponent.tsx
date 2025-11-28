import { NodeViewWrapper } from '@tiptap/react';
import { useState, useEffect } from 'react';
import CryptoJS from 'crypto-js';
import { Lock, Unlock, Eye, EyeOff, KeyRound, Save, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import toast from 'react-hot-toast';

interface EncryptedBlockProps {
  node: {
    attrs: {
      ciphertext: string;
    };
  };
  updateAttributes: (attrs: { ciphertext: string }) => void;
  deleteNode: () => void;
}

const VALIDATION_PREFIX = "NOTIQ-SECURE:";

export default function EncryptedBlockComponent({ node, updateAttributes, deleteNode }: EncryptedBlockProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'SETUP' | 'LOCKED' | 'UNLOCKED'>('SETUP');
  const [pin, setPin] = useState('');
  const [content, setContent] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (node.attrs.ciphertext) {
      setMode('LOCKED');
    } else {
      setMode('SETUP');
    }
  }, [node.attrs.ciphertext]);

  const handleEncrypt = () => {
    if (!pin || pin.length < 4) {
      setError(t('encryption.pinTooShort', 'PIN must be at least 4 characters'));
      return;
    }
    if (!content) {
      setError(t('encryption.contentEmpty', 'Content cannot be empty'));
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
      } else {
        setError(t('encryption.wrongPin', 'Incorrect PIN'));
      }
    } catch (e) {
      console.error(e);
      setError(t('encryption.wrongPin', 'Incorrect PIN'));
    }
  };

  const handleReLock = () => {
    // When re-locking, we use the CURRENT pin (which the user must have entered to unlock)
    // If we want to support changing the PIN, we'd need a different flow.
    // For now, simple re-lock.
    handleEncrypt();
  };

  return (
    <NodeViewWrapper className="my-4">
      <div className={clsx(
        "rounded-lg border-2 overflow-hidden transition-all",
        mode === 'LOCKED' ? "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-900/20" :
          mode === 'UNLOCKED' ? "border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-900/20" :
            "border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-900/20"
      )}>
        {/* Header */}
        <div className={clsx(
          "px-4 py-2 flex items-center justify-between border-b",
          mode === 'LOCKED' ? "bg-red-100 border-red-200 dark:bg-red-900/40 dark:border-red-900 text-red-700 dark:text-red-300" :
            mode === 'UNLOCKED' ? "bg-emerald-100 border-emerald-200 dark:bg-emerald-900/40 dark:border-emerald-900 text-emerald-700 dark:text-emerald-300" :
              "bg-blue-100 border-blue-200 dark:bg-blue-900/40 dark:border-blue-900 text-blue-700 dark:text-blue-300"
        )}>
          <div className="flex items-center gap-2 font-semibold">
            {mode === 'LOCKED' && <Lock size={16} />}
            {mode === 'UNLOCKED' && <Unlock size={16} />}
            {mode === 'SETUP' && <KeyRound size={16} />}
            <span>
              {mode === 'LOCKED' ? t('encryption.locked', 'Encrypted Content') :
                mode === 'UNLOCKED' ? t('encryption.unlocked', 'Decrypted Content') :
                  t('encryption.setup', 'New Encrypted Block')}
            </span>
          </div>
          {mode === 'SETUP' && (
            <button onClick={deleteNode} className="text-gray-500 hover:text-red-500">
              <AlertTriangle size={16} />
            </button>
          )}
        </div>

        {/* Body */}
        <div className="p-4">
          {mode === 'LOCKED' && (
            <div className="flex flex-col gap-3 items-center justify-center py-4">
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                {t('encryption.enterPinToUnlock', 'Enter PIN to view content')}
              </p>
              <div className="flex gap-2 w-full max-w-xs">
                <div className="relative flex-1">
                  <input
                    type={showPin ? "text" : "password"}
                    value={pin}
                    onChange={(e) => { setPin(e.target.value); setError(''); }}
                    placeholder="PIN"
                    className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 dark:bg-gray-800 focus:ring-2 focus:ring-red-500 outline-none"
                    onKeyDown={(e) => e.key === 'Enter' && handleDecrypt()}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPin(!showPin)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  >
                    {showPin ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                <button
                  onClick={handleDecrypt}
                  className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded font-medium transition-colors"
                >
                  {t('common.unlock', 'Unlock')}
                </button>
              </div>
              {error && <p className="text-red-500 text-sm mt-1">{error}</p>}
            </div>
          )}

          {(mode === 'SETUP' || mode === 'UNLOCKED') && (
            <div className="flex flex-col gap-3">
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder={t('encryption.contentPlaceholder', 'Enter confidential content here...')}
                className="w-full min-h-[100px] p-3 rounded border border-gray-300 dark:border-gray-600 dark:bg-gray-800 focus:ring-2 focus:ring-blue-500 outline-none resize-y"
              />

              <div className="flex items-end gap-3">
                <div className="flex-1">
                  <label className="block text-xs font-medium text-gray-500 mb-1">
                    {mode === 'UNLOCKED' ? t('encryption.confirmPinToLock', 'Confirm PIN to Re-lock') : t('encryption.setPin', 'Set Encryption PIN')}
                  </label>
                  <div className="relative">
                    <input
                      type={showPin ? "text" : "password"}
                      value={pin}
                      onChange={(e) => { setPin(e.target.value); setError(''); }}
                      placeholder="PIN"
                      className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 dark:bg-gray-800 focus:ring-2 focus:ring-blue-500 outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPin(!showPin)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                    >
                      {showPin ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>
                <button
                  onClick={handleEncrypt}
                  className={clsx(
                    "px-4 py-2 rounded font-medium transition-colors flex items-center gap-2 h-[42px]",
                    mode === 'UNLOCKED'
                      ? "bg-emerald-600 hover:bg-emerald-700 text-white"
                      : "bg-blue-600 hover:bg-blue-700 text-white"
                  )}
                >
                  {mode === 'UNLOCKED' ? <Lock size={16} /> : <Save size={16} />}
                  {mode === 'UNLOCKED' ? t('common.lock', 'Lock') : t('common.encrypt', 'Encrypt')}
                </button>
              </div>
              {error && <p className="text-red-500 text-sm">{error}</p>}
              <p className="text-xs text-gray-400">
                {t('encryption.warning', 'Warning: If you lose this PIN, the content cannot be recovered.')}
              </p>
            </div>
          )}
        </div>
      </div>
    </NodeViewWrapper>
  );
}
