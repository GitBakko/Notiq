import { useTranslation } from 'react-i18next';
import { it, enUS } from 'date-fns/locale';
import { useReminders } from '../../hooks/useReminders';
import { format, isPast, isToday, isFuture } from 'date-fns';
import { CheckCircle, Circle, Calendar, Menu } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { updateNote } from '../notes/noteService';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useUIStore } from '../../store/uiStore';

export default function RemindersPage() {
    const { t, i18n } = useTranslation();
    const dateLocale = i18n.language.startsWith('it') ? it : enUS;
    const tasks = useReminders();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const isMobile = useIsMobile();
    const { toggleSidebar } = useUIStore();

    const toggleTask = useMutation({
        mutationFn: ({ id, isDone }: { id: string, isDone: boolean }) =>
            updateNote(id, { isReminderDone: isDone }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['notes'] });
        }
    });

    if (!tasks) return <div className="p-8 text-center text-gray-500">{t('common.loading')}</div>;

    const overdue = tasks.filter(t => !t.isReminderDone && t.reminderDate && isPast(new Date(t.reminderDate)) && !isToday(new Date(t.reminderDate)));
    const today = tasks.filter(t => !t.isReminderDone && t.reminderDate && isToday(new Date(t.reminderDate)));
    const upcoming = tasks.filter(t => !t.isReminderDone && t.reminderDate && isFuture(new Date(t.reminderDate)) && !isToday(new Date(t.reminderDate)));
    const done = tasks.filter(t => t.isReminderDone);

    const TaskItem = ({ task }: { task: { id: string; title: string; isReminderDone?: boolean; reminderDate?: string | null } }) => (
        <div className="flex items-center gap-3 p-3 bg-white border border-gray-200 rounded-lg hover:shadow-sm transition-shadow group dark:bg-gray-800 dark:border-gray-700">
            <button
                onClick={(e) => {
                    e.stopPropagation();
                    toggleTask.mutate({ id: task.id, isDone: !task.isReminderDone });
                }}
                className="text-gray-400 hover:text-emerald-600 dark:text-gray-500 dark:hover:text-emerald-400"
            >
                {task.isReminderDone ? <CheckCircle className="text-emerald-600 dark:text-emerald-500" /> : <Circle />}
            </button>
            <div
                className="flex-1 cursor-pointer"
                onClick={() => navigate(`/notes?noteId=${task.id}`)}
            >
                <div className={clsx("font-medium dark:text-gray-200", task.isReminderDone && "line-through text-gray-400 dark:text-gray-500")}>{task.title || t('notes.untitled')}</div>
                <div className="text-xs text-gray-500 flex items-center gap-1 dark:text-gray-400">
                    <Calendar size={12} />
                    {task.reminderDate ? format(new Date(task.reminderDate), 'PPP p', { locale: dateLocale }) : ''}
                </div>
            </div>
        </div>
    );

    return (
        <div className="flex-1 h-full overflow-y-auto bg-gray-50 p-8 dark:bg-gray-900">
            <div className="flex items-center gap-3 mb-6">
                {isMobile && (
                    <button onClick={toggleSidebar} className="text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200">
                        <Menu size={24} />
                    </button>
                )}
                <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{t('sidebar.reminders')}</h1>
            </div>

            <div className="max-w-3xl mx-auto space-y-8">
                {overdue.length > 0 && (
                    <section>
                        <h2 className="text-lg font-semibold text-red-600 mb-3 dark:text-red-400">{t('tasks.overdue')}</h2>
                        <div className="space-y-2">
                            {overdue.map(task => <TaskItem key={task.id} task={task} />)}
                        </div>
                    </section>
                )}

                {today.length > 0 && (
                    <section>
                        <h2 className="text-lg font-semibold text-emerald-600 mb-3 dark:text-emerald-400">{t('tasks.today')}</h2>
                        <div className="space-y-2">
                            {today.map(task => <TaskItem key={task.id} task={task} />)}
                        </div>
                    </section>
                )}

                {upcoming.length > 0 && (
                    <section>
                        <h2 className="text-lg font-semibold text-gray-700 mb-3 dark:text-gray-300">{t('tasks.upcoming')}</h2>
                        <div className="space-y-2">
                            {upcoming.map(task => <TaskItem key={task.id} task={task} />)}
                        </div>
                    </section>
                )}

                {done.length > 0 && (
                    <section>
                        <h2 className="text-lg font-semibold text-gray-400 mb-3 dark:text-gray-500">{t('tasks.completed')}</h2>
                        <div className="space-y-2 opacity-75">
                            {done.map(task => <TaskItem key={task.id} task={task} />)}
                        </div>
                    </section>
                )}

                {tasks.length === 0 && (
                    <div className="text-center py-12 text-gray-400 dark:text-gray-500">
                        <CheckCircle size={48} className="mx-auto mb-4 opacity-20" />
                        <p>{t('tasks.noTasks')}</p>
                    </div>
                )}
            </div>
        </div>
    );
}
