import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, Eye } from 'lucide-react';
import { Dialog } from '../../../components/ui/Dialog';
import { Button } from '../../../components/ui/Button';
import api from '../../../lib/api';

interface BulkArchiveDialogProps {
  isOpen: boolean;
  onClose: () => void;
  boardId: string;
  onPreview: (cardIds: Set<string>) => void;
  onArchived: () => void;
}

interface PreviewCard {
  id: string;
  title: string;
  updatedAt: string;
}

export default function BulkArchiveDialog({
  isOpen,
  onClose,
  boardId,
  onPreview,
  onArchived,
}: BulkArchiveDialogProps) {
  const { t } = useTranslation();
  const [days, setDays] = useState(7);
  const [previewCards, setPreviewCards] = useState<PreviewCard[]>([]);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);
  const [hasPreviewedOnce, setHasPreviewedOnce] = useState(false);

  const reset = useCallback(() => {
    setPreviewCards([]);
    setIsPreviewing(false);
    setIsArchiving(false);
    setHasPreviewedOnce(false);
    setDays(7);
    onPreview(new Set());
  }, [onPreview]);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  const handlePreview = useCallback(async () => {
    setIsPreviewing(true);
    try {
      const res = await api.post(`/kanban/boards/${boardId}/bulk-archive-preview`, { olderThanDays: days });
      const cards = res.data as PreviewCard[];
      setPreviewCards(cards);
      setHasPreviewedOnce(true);
      onPreview(new Set(cards.map((c) => c.id)));
    } finally {
      setIsPreviewing(false);
    }
  }, [boardId, days, onPreview]);

  const handleArchive = useCallback(async () => {
    if (previewCards.length === 0) return;
    setIsArchiving(true);
    try {
      await api.post(`/kanban/boards/${boardId}/bulk-archive`, {
        cardIds: previewCards.map((c) => c.id),
      });
      onPreview(new Set());
      onArchived();
      handleClose();
    } finally {
      setIsArchiving(false);
    }
  }, [boardId, previewCards, onPreview, onArchived, handleClose]);

  return (
    <Dialog isOpen={isOpen} onClose={handleClose} title={t('kanban.bulkArchive.title')}>
      <p className="text-sm text-neutral-500 dark:text-neutral-400 mb-4">
        {t('kanban.bulkArchive.description')}
      </p>

      {/* Days input */}
      <div className="flex items-center gap-3 mb-4">
        <label className="text-sm font-medium text-neutral-700 dark:text-neutral-300 whitespace-nowrap">
          {t('kanban.bulkArchive.olderThan')}
        </label>
        <input
          type="number"
          min={0}
          max={365}
          value={days}
          onChange={(e) => {
            setDays(Math.max(0, Math.min(365, parseInt(e.target.value) || 0)));
            setHasPreviewedOnce(false);
            setPreviewCards([]);
            onPreview(new Set());
          }}
          className="w-20 bg-white dark:bg-neutral-800 border border-neutral-200/60 dark:border-neutral-600 rounded-lg px-3 py-1.5 text-sm text-neutral-900 dark:text-white outline-none focus:border-emerald-500 dark:focus:border-emerald-400 text-center"
        />
        <span className="text-sm text-neutral-500 dark:text-neutral-400">
          {t('kanban.bulkArchive.days')}
        </span>
      </div>

      {/* Preview button */}
      <Button
        variant="secondary"
        onClick={handlePreview}
        isLoading={isPreviewing}
        className="w-full mb-4"
      >
        <Eye size={16} className="mr-2" />
        {t('kanban.bulkArchive.preview')}
      </Button>

      {/* Preview results */}
      {hasPreviewedOnce && (
        <div className="mb-4">
          {previewCards.length === 0 ? (
            <p className="text-sm text-neutral-400 dark:text-neutral-500 italic text-center py-2">
              {t('kanban.bulkArchive.noCards')}
            </p>
          ) : (
            <>
              <p className="text-sm font-medium text-amber-600 dark:text-amber-400 mb-2">
                {t('kanban.bulkArchive.found', { count: previewCards.length })}
              </p>
              <div className="max-h-40 overflow-y-auto space-y-1 rounded-lg border border-neutral-200/60 dark:border-neutral-700/40 p-2">
                {previewCards.map((card) => (
                  <div
                    key={card.id}
                    className="flex items-center gap-2 px-2 py-1.5 rounded bg-amber-50 dark:bg-amber-900/20 text-sm"
                  >
                    <Archive size={12} className="flex-shrink-0 text-amber-500" />
                    <span className="truncate text-neutral-700 dark:text-neutral-300">{card.title}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="flex justify-end gap-3">
        <Button variant="ghost" onClick={handleClose}>
          {t('common.cancel')}
        </Button>
        {previewCards.length > 0 && (
          <Button
            variant="danger"
            onClick={handleArchive}
            isLoading={isArchiving}
          >
            <Archive size={16} className="mr-2" />
            {t('kanban.bulkArchive.archive', { count: previewCards.length })}
          </Button>
        )}
      </div>
    </Dialog>
  );
}
