import { useTranslation } from 'react-i18next';
import { Sparkles, Wrench, Zap } from 'lucide-react';
import type { ChangelogEntry } from '../../data/changelog';

interface TypeBadgeProps {
  type: ChangelogEntry['type'];
}

export default function TypeBadge({ type }: TypeBadgeProps) {
  const { t } = useTranslation();

  if (type === 'feature') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
        <Sparkles size={12} />
        {t('whatsNew.feature')}
      </span>
    );
  }

  if (type === 'fix') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
        <Wrench size={12} />
        {t('whatsNew.fix')}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
      <Zap size={12} />
      {t('whatsNew.improvement')}
    </span>
  );
}
