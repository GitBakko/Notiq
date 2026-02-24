import { useTranslation } from 'react-i18next';
import { it, enUS } from 'date-fns/locale';
import { useReminders } from '../../hooks/useReminders';
import { useKanbanReminders, useToggleKanbanReminder } from '../../hooks/useKanbanReminders';
import type { KanbanReminderItem } from '../../hooks/useKanbanReminders';
import { format, isPast, isToday, isFuture } from 'date-fns';
import { CheckCircle, Circle, Calendar, Menu, FileText, LayoutDashboard } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { updateNote } from '../notes/noteService';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useUIStore } from '../../store/uiStore';

interface UnifiedReminder {
  id: string;
  title: string;
  dueDate: string;
  isDone: boolean;
  type: 'note' | 'kanban';
  noteId?: string;
  cardId?: string;
  boardId?: string;
  boardTitle?: string;
  columnTitle?: string;
}

export default function RemindersPage() {
  const { t, i18n } = useTranslation();
  const dateLocale = i18n.language.startsWith('it') ? it : enUS;
  const noteReminders = useReminders();
  const { data: kanbanReminders } = useKanbanReminders();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const { toggleSidebar } = useUIStore();

  const toggleNoteTask = useMutation({
    mutationFn: ({ id, isDone }: { id: string; isDone: boolean }) =>
      updateNote(id, { isReminderDone: isDone }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notes'] });
    },
  });

  const toggleKanbanTask = useToggleKanbanReminder();

  // Merge note + kanban reminders into unified list
  const unified: UnifiedReminder[] = [];

  if (noteReminders) {
    for (const note of noteReminders) {
      if (note.reminderDate) {
        unified.push({
          id: note.id,
          title: note.title || t('notes.untitled'),
          dueDate: note.reminderDate,
          isDone: !!note.isReminderDone,
          type: 'note',
          noteId: note.id,
        });
      }
    }
  }

  if (kanbanReminders) {
    for (const kr of kanbanReminders) {
      unified.push({
        id: kr.id,
        title: kr.cardTitle,
        dueDate: kr.dueDate,
        isDone: kr.isDone,
        type: 'kanban',
        cardId: kr.cardId,
        boardId: kr.boardId,
        boardTitle: kr.boardTitle,
        columnTitle: kr.columnTitle,
      });
    }
  }

  // Sort by dueDate
  unified.sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());

  const isLoading = !noteReminders && !kanbanReminders;

  if (isLoading) return <div className="p-8 text-center text-gray-500">{t('common.loading')}</div>;

  const overdue = unified.filter((r) => !r.isDone && isPast(new Date(r.dueDate)) && !isToday(new Date(r.dueDate)));
  const today = unified.filter((r) => !r.isDone && isToday(new Date(r.dueDate)));
  const upcoming = unified.filter((r) => !r.isDone && isFuture(new Date(r.dueDate)) && !isToday(new Date(r.dueDate)));
  const done = unified.filter((r) => r.isDone);

  function handleToggle(item: UnifiedReminder) {
    if (item.type === 'note' && item.noteId) {
      toggleNoteTask.mutate({ id: item.noteId, isDone: !item.isDone });
    } else if (item.type === 'kanban') {
      toggleKanbanTask.mutate({ id: item.id, isDone: !item.isDone });
    }
  }

  function handleClick(item: UnifiedReminder) {
    if (item.type === 'note' && item.noteId) {
      navigate(`/notes?noteId=${item.noteId}`);
    } else if (item.type === 'kanban' && item.boardId) {
      navigate(`/kanban/${item.boardId}`);
    }
  }

  const ReminderItem = ({ item }: { item: UnifiedReminder }) => (
    <div className="flex items-center gap-3 p-3 bg-white border border-gray-200 rounded-lg hover:shadow-sm transition-shadow group dark:bg-gray-800 dark:border-gray-700">
      <button
        onClick={(e) => {
          e.stopPropagation();
          handleToggle(item);
        }}
        className="text-gray-400 hover:text-emerald-600 dark:text-gray-500 dark:hover:text-emerald-400"
      >
        {item.isDone ? (
          <CheckCircle className="text-emerald-600 dark:text-emerald-500" />
        ) : (
          <Circle />
        )}
      </button>
      <div className="flex-1 cursor-pointer min-w-0" onClick={() => handleClick(item)}>
        <div className="flex items-center gap-2">
          {item.type === 'note' ? (
            <FileText size={14} className="text-blue-500 dark:text-blue-400 flex-shrink-0" />
          ) : (
            <LayoutDashboard size={14} className="text-purple-500 dark:text-purple-400 flex-shrink-0" />
          )}
          <span
            className={clsx(
              'font-medium truncate dark:text-gray-200',
              item.isDone && 'line-through text-gray-400 dark:text-gray-500'
            )}
          >
            {item.title}
          </span>
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-xs text-gray-500 flex items-center gap-1 dark:text-gray-400">
            <Calendar size={12} />
            {format(new Date(item.dueDate), 'PPP p', { locale: dateLocale })}
          </span>
          {item.type === 'kanban' && item.boardTitle && (
            <span className="text-xs text-purple-500 dark:text-purple-400 truncate">
              {item.boardTitle}
            </span>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex-1 h-full overflow-y-auto bg-gray-50 p-8 dark:bg-gray-900">
      <div className="flex items-center gap-3 mb-6">
        {isMobile && (
          <button
            onClick={toggleSidebar}
            className="text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200"
          >
            <Menu size={24} />
          </button>
        )}
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
          {t('sidebar.reminders')}
        </h1>
      </div>

      <div className="max-w-3xl mx-auto space-y-8">
        {overdue.length > 0 && (
          <section>
            <h2 className="text-lg font-semibold text-red-600 mb-3 dark:text-red-400">
              {t('tasks.overdue')}
            </h2>
            <div className="space-y-2">
              {overdue.map((item) => (
                <ReminderItem key={`${item.type}-${item.id}`} item={item} />
              ))}
            </div>
          </section>
        )}

        {today.length > 0 && (
          <section>
            <h2 className="text-lg font-semibold text-emerald-600 mb-3 dark:text-emerald-400">
              {t('tasks.today')}
            </h2>
            <div className="space-y-2">
              {today.map((item) => (
                <ReminderItem key={`${item.type}-${item.id}`} item={item} />
              ))}
            </div>
          </section>
        )}

        {upcoming.length > 0 && (
          <section>
            <h2 className="text-lg font-semibold text-gray-700 mb-3 dark:text-gray-300">
              {t('tasks.upcoming')}
            </h2>
            <div className="space-y-2">
              {upcoming.map((item) => (
                <ReminderItem key={`${item.type}-${item.id}`} item={item} />
              ))}
            </div>
          </section>
        )}

        {done.length > 0 && (
          <section>
            <h2 className="text-lg font-semibold text-gray-400 mb-3 dark:text-gray-500">
              {t('tasks.completed')}
            </h2>
            <div className="space-y-2 opacity-75">
              {done.map((item) => (
                <ReminderItem key={`${item.type}-${item.id}`} item={item} />
              ))}
            </div>
          </section>
        )}

        {unified.length === 0 && (
          <div className="text-center py-12 text-gray-400 dark:text-gray-500">
            <CheckCircle size={48} className="mx-auto mb-4 opacity-20" />
            <p>{t('tasks.noTasks')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
