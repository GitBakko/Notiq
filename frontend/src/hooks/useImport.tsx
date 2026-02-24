
import { useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import axios from 'axios';
import { useAuthStore } from '../store/authStore';
import { syncPull } from '../features/sync/syncService';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db';
import { X, FileDown } from 'lucide-react';

interface UseImportOptions {
  source?: 'evernote' | 'onenote';
  onSuccess?: (count: number) => void;
  onError?: (error: any) => void;
}

export const useImport = (options?: UseImportOptions) => {
  const source = options?.source || 'evernote';
  const { t } = useTranslation();
  const [isUploading, setIsUploading] = useState(false);
  const [showNotebookPicker, setShowNotebookPicker] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scopeRef = useRef<{ notebookId?: string; isVault?: boolean }>({});
  const user = useAuthStore((state) => state.user);

  const notebooks = useLiveQuery(async () => {
    if (!user?.id) return [];
    return db.notebooks.where('userId').equals(user.id).sortBy('name');
  }, [user?.id]);

  const startUpload = useCallback((notebookId: string, isVault?: boolean) => {
    scopeRef.current = { notebookId, isVault };
    fileInputRef.current?.click();
  }, []);

  const importFile = useCallback((notebookId?: string, isVault?: boolean) => {
    if (notebookId) {
      startUpload(notebookId, isVault);
      return;
    }

    // No notebookId provided — need to pick one
    const nbs = notebooks || [];
    if (nbs.length === 0) {
      toast.error(t('notes.selectNotebookFirst'));
      return;
    }
    if (nbs.length === 1) {
      startUpload(nbs[0].id, isVault);
      return;
    }

    // Multiple notebooks — show picker
    scopeRef.current = { isVault };
    setShowNotebookPicker(true);
  }, [notebooks, startUpload, t]);

  const handlePickNotebook = useCallback((notebookId: string) => {
    setShowNotebookPicker(false);
    startUpload(notebookId, scopeRef.current.isVault);
  }, [startUpload]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (source === 'evernote') {
      if (!file.name.endsWith('.enex')) {
        toast.error(t('settings.importError') + ' (.enex)');
        return;
      }
    } else {
      if (!file.name.match(/\.(mht|mhtml|html?|zip)$/i)) {
        toast.error(t('settings.importError') + ' (.mht, .html, .zip)');
        return;
      }
    }

    const { notebookId, isVault } = scopeRef.current;

    const formData = new FormData();
    formData.append('file', file);

    setIsUploading(true);
    const toastId = toast.loading(t('settings.importing'));

    try {
      const token = useAuthStore.getState().token;

      const params = new URLSearchParams();
      if (notebookId) params.append('notebookId', notebookId);
      if (isVault) params.append('isVault', 'true');

      const endpoint = source === 'evernote' ? 'evernote' : 'onenote';
      const response = await axios.post(`${import.meta.env.VITE_API_URL || '/api'}/import/${endpoint}?${params.toString()}`, formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
          'Authorization': `Bearer ${token}`
        }
      });

      const count = response.data.importedCount;
      toast.success(t('settings.importSuccess', { count }));

      await syncPull();

      options?.onSuccess?.(count);
    } catch (error) {
      console.error(error);
      toast.error(t('settings.importError'));
      options?.onError?.(error);
    } finally {
      setIsUploading(false);
      toast.dismiss(toastId);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const acceptTypes = source === 'evernote' ? '.enex' : '.mht,.mhtml,.html,.htm,.zip';

  const hiddenInput = (
    <input
      type="file"
      accept={acceptTypes}
      ref={fileInputRef}
      className="hidden"
      onChange={handleFileChange}
    />
  );

  const notebookPickerModal = showNotebookPicker ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowNotebookPicker(false)}>
      <div
        className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <FileDown size={18} className="text-emerald-600 dark:text-emerald-400" />
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              {t('import.selectNotebook')}
            </h3>
          </div>
          <button onClick={() => setShowNotebookPicker(false)} className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500">
            <X size={18} />
          </button>
        </div>
        <div className="px-3 py-3 max-h-64 overflow-y-auto">
          {(notebooks || []).map(nb => (
            <button
              key={nb.id}
              onClick={() => handlePickNotebook(nb.id)}
              className="w-full text-left px-3 py-2.5 rounded-lg text-sm text-gray-700 dark:text-gray-200 hover:bg-emerald-50 hover:text-emerald-700 dark:hover:bg-emerald-900/30 dark:hover:text-emerald-400 transition-colors"
            >
              {nb.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  ) : null;

  return {
    isUploading,
    importFile,
    hiddenInput,
    notebookPickerModal
  };
};
