import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { PRIORITY_CONFIG } from '../../utils/priorityConfig';

const badgeColors = {
  LOW: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400',
  MEDIUM: 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400',
  HIGH: 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400',
};

export default function TaskPriorityBadge({ priority }: { priority: 'LOW' | 'MEDIUM' | 'HIGH' }) {
  const { t } = useTranslation();
  const Icon = PRIORITY_CONFIG[priority].icon;
  return (
    <span className={clsx('inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium', badgeColors[priority])}>
      <Icon size={10} />
      {t(`taskLists.priority.${priority.toLowerCase()}`)}
    </span>
  );
}
