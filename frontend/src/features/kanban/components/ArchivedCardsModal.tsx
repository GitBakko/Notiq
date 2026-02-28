import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { it as itLocale, enUS } from 'date-fns/locale';
import { Archive, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../components/ui/Modal';
import * as kanbanService from '../kanbanService';

interface ArchivedCardsModalProps {
  isOpen: boolean;
  onClose: () => void;
  boardId: string;
  onUnarchive: () => void;
}

export default function ArchivedCardsModal({ isOpen, onClose, boardId, onUnarchive }: ArchivedCardsModalProps) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const dateLocale = i18n.language?.startsWith('it') ? itLocale : enUS;

  const { data: archivedCards, isLoading } = useQuery({
    queryKey: ['kanban-archived-cards', boardId],
    queryFn: () => kanbanService.getArchivedCards(boardId),
    enabled: isOpen,
  });

  async function handleUnarchive(cardId: string): Promise<void> {
    await kanbanService.unarchiveCard(cardId);
    queryClient.invalidateQueries({ queryKey: ['kanban-archived-cards', boardId] });
    queryClient.invalidateQueries({ queryKey: ['kanban-board', boardId] });
    queryClient.invalidateQueries({ queryKey: ['kanban-boards'] });
    onUnarchive();
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('kanban.archive.title')} size="md">
      <div className="space-y-2 max-h-[60vh] overflow-y-auto">
        {isLoading ? (
          <div className="flex justify-center py-8">
            <div className="w-5 h-5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : archivedCards && archivedCards.length > 0 ? (
          archivedCards.map((card) => (
            <div
              key={card.id}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-neutral-200/60 dark:border-neutral-700/40 bg-neutral-50 dark:bg-neutral-800/50"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-neutral-900 dark:text-white truncate">
                  {card.title}
                </p>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-xs text-neutral-500 dark:text-neutral-400">
                    {card.columnTitle}
                  </span>
                  <span className="text-xs text-neutral-400 dark:text-neutral-500">
                    {t('kanban.archive.archivedOn', {
                      date: format(new Date(card.archivedAt), 'dd MMM yyyy', { locale: dateLocale }),
                    })}
                  </span>
                </div>
              </div>
              <button
                onClick={() => handleUnarchive(card.id)}
                className="flex-shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 rounded-lg transition-colors"
                title={t('kanban.archive.unarchive')}
              >
                <RotateCcw size={12} />
                {t('kanban.archive.unarchive')}
              </button>
            </div>
          ))
        ) : (
          <div className="text-center py-12">
            <Archive className="mx-auto text-neutral-300 dark:text-neutral-600 mb-3" size={36} />
            <p className="text-sm text-neutral-400 dark:text-neutral-500">
              {t('kanban.archive.empty')}
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}
