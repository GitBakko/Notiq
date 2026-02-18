
import { useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import axios from 'axios';
import { useAuthStore } from '../store/authStore';
import { syncPull } from '../features/sync/syncService';

interface UseImportOptions {
  onSuccess?: (count: number) => void;
  onError?: (error: any) => void;
}

export const useImport = (options?: UseImportOptions) => {
  const { t } = useTranslation();
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const importFile = async (notebookId?: string, isVault?: boolean) => {
    scopeRef.current = { notebookId, isVault };
    fileInputRef.current?.click();
  };

  const scopeRef = useRef<{ notebookId?: string; isVault?: boolean }>({});

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.name.endsWith('.enex')) {
      toast.error(t('settings.importError') + ' (.enex)');
      return;
    }

    const { notebookId, isVault } = scopeRef.current;

    const formData = new FormData();
    formData.append('file', file);

    setIsUploading(true);
    const toastId = toast.loading(t('settings.importing'));

    try {
      const token = useAuthStore.getState().token;

      // Build Query Params
      const params = new URLSearchParams();
      if (notebookId) params.append('notebookId', notebookId);
      if (isVault) params.append('isVault', 'true');

      const response = await axios.post(`${import.meta.env.VITE_API_URL || '/api'}/import/evernote?${params.toString()}`, formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
          'Authorization': `Bearer ${token}`
        }
      });

      const count = response.data.importedCount;
      toast.success(t('settings.importSuccess', { count }));

      // Trigger sync to fetch new notes immediately
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

  const hiddenInput = (
    <input
      type="file"
      accept=".enex"
      ref={fileInputRef}
      className="hidden"
      onChange={handleFileChange}
    />
  );

  return {
    isUploading,
    importFile,
    hiddenInput
  };
};
