import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Loader2, History, RotateCcw } from 'lucide-react';
import toast from 'react-hot-toast';
import { getNoteVersions, restoreNoteVersion, type NoteVersionDto } from './noteService';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';

interface VersionHistoryModalProps {
  noteId: string;
  onClose: () => void;
  onRestored: () => void;
}

function plainPreview(content: string): string {
  try {
    const json = JSON.parse(content) as { text?: string; content?: unknown[] };
    const walk = (node: { text?: string; content?: unknown[] }): string => {
      if (node.text) return node.text;
      if (Array.isArray(node.content)) return node.content.map((c) => walk(c as { text?: string; content?: unknown[] })).join(' ');
      return '';
    };
    return walk(json).slice(0, 160);
  } catch {
    return content.replace(/<[^>]*>/g, ' ').slice(0, 160);
  }
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString();
}

export default function VersionHistoryModal({ noteId, onClose, onRestored }: VersionHistoryModalProps) {
  const { t } = useTranslation();
  const [versions, setVersions] = useState<NoteVersionDto[] | null>(null);
  const [error, setError] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    getNoteVersions(noteId)
      .then((v) => { if (!cancelled) setVersions(v); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [noteId]);

  const doRestore = async () => {
    if (!confirmId) return;
    setRestoring(true);
    try {
      await restoreNoteVersion(noteId, confirmId);
      toast.success(t('notes.versions.restored'));
      setConfirmId(null);
      onRestored();
    } catch {
      toast.error(t('notes.versions.restoreFailed'));
      setRestoring(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl bg-white dark:bg-neutral-900 shadow-xl">
        <div className="sticky top-0 flex items-center justify-between border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-5 py-4">
          <h2 className="flex items-center gap-2 text-base font-semibold text-neutral-900 dark:text-neutral-100">
            <History size={18} /> {t('notes.versions.title')}
          </h2>
          <button
            onClick={onClose}
            aria-label={t('common.close')}
            className="flex h-11 w-11 items-center justify-center rounded-lg text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-5">
          {error && (
            <p className="text-sm text-red-600 dark:text-red-400">{t('notes.versions.loadFailed')}</p>
          )}
          {!error && versions === null && (
            <div className="flex justify-center py-8">
              <Loader2 className="animate-spin text-neutral-400" />
            </div>
          )}
          {versions !== null && versions.length === 0 && (
            <p className="py-8 text-center text-sm text-neutral-500 dark:text-neutral-400">
              {t('notes.versions.empty')}
            </p>
          )}
          {versions !== null && versions.length > 0 && (
            <ul className="space-y-2">
              {versions.map((v) => (
                <li
                  key={v.id}
                  className="flex items-start justify-between gap-3 rounded-lg border border-neutral-200 dark:border-neutral-800 p-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
                      {formatDateTime(v.createdAt)}
                    </p>
                    <p className="truncate text-xs text-neutral-500 dark:text-neutral-400">
                      {plainPreview(v.content) || v.title}
                    </p>
                  </div>
                  <button
                    onClick={() => setConfirmId(v.id)}
                    disabled={restoring}
                    className="flex min-h-[44px] items-center gap-1.5 rounded-lg bg-neutral-100 dark:bg-neutral-800 px-3 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    <RotateCcw size={14} /> {t('notes.versions.restore')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <ConfirmDialog
        isOpen={confirmId !== null}
        onClose={() => setConfirmId(null)}
        onConfirm={doRestore}
        title={t('notes.versions.confirmTitle')}
        message={t('notes.versions.confirmMessage')}
        confirmText={t('notes.versions.restore')}
      />
    </div>
  );
}
