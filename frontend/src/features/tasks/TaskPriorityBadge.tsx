import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

const priorityConfig = {
  LOW: { bg: 'bg-green-100 dark:bg-green-900/30', text: 'text-green-700 dark:text-green-400', dot: 'bg-green-500' },
  MEDIUM: { bg: 'bg-yellow-100 dark:bg-yellow-900/30', text: 'text-yellow-700 dark:text-yellow-400', dot: 'bg-yellow-500' },
  HIGH: { bg: 'bg-red-100 dark:bg-red-900/30', text: 'text-red-700 dark:text-red-400', dot: 'bg-red-500' },
};

export default function TaskPriorityBadge({ priority }: { priority: 'LOW' | 'MEDIUM' | 'HIGH' }) {
  const { t } = useTranslation();
  const config = priorityConfig[priority];
  return (
    <span className={clsx('inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium', config.bg, config.text)}>
      <span className={clsx('w-1.5 h-1.5 rounded-full', config.dot)} />
      {t(`taskLists.priority.${priority.toLowerCase()}`)}
    </span>
  );
}
