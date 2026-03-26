import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Wrench, Sparkles, X } from 'lucide-react';
import clsx from 'clsx';
import { getActiveAnnouncements, dismissAnnouncement } from './announcementService';
import type { Announcement } from './announcementService';

function extractPreviewText(content: string): string {
  try {
    const parsed = JSON.parse(content);
    if (parsed && parsed.content) {
      const texts: string[] = [];
      const walk = (node: { type?: string; text?: string; content?: unknown[] }) => {
        if (node.text) {
          texts.push(node.text);
        }
        if (Array.isArray(node.content)) {
          node.content.forEach((child) => walk(child as { type?: string; text?: string; content?: unknown[] }));
        }
      };
      walk(parsed);
      const plain = texts.join(' ');
      return plain.length > 150 ? plain.slice(0, 150) + '...' : plain;
    }
  } catch {
    // Not valid JSON — try stripping HTML tags
  }

  const stripped = content.replace(/<[^>]*>/g, '').trim();
  return stripped.length > 150 ? stripped.slice(0, 150) + '...' : stripped;
}

const categoryConfig = {
  URGENT: {
    bg: 'bg-red-50 dark:bg-red-950/40',
    border: 'border-red-200 dark:border-red-800',
    icon: AlertTriangle,
    iconColor: 'text-red-600 dark:text-red-400',
    titleColor: 'text-red-900 dark:text-red-100',
    textColor: 'text-red-700 dark:text-red-300',
    dismissColor: 'text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-200',
  },
  MAINTENANCE: {
    bg: 'bg-amber-50 dark:bg-amber-950/40',
    border: 'border-amber-200 dark:border-amber-800',
    icon: Wrench,
    iconColor: 'text-amber-600 dark:text-amber-400',
    titleColor: 'text-amber-900 dark:text-amber-100',
    textColor: 'text-amber-700 dark:text-amber-300',
    dismissColor: 'text-amber-500 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-200',
  },
  FEATURE: {
    bg: 'bg-emerald-50 dark:bg-emerald-950/40',
    border: 'border-emerald-200 dark:border-emerald-800',
    icon: Sparkles,
    iconColor: 'text-emerald-600 dark:text-emerald-400',
    titleColor: 'text-emerald-900 dark:text-emerald-100',
    textColor: 'text-emerald-700 dark:text-emerald-300',
    dismissColor: 'text-emerald-500 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-200',
  },
} as const;

function AnnouncementItem({ announcement }: { announcement: Announcement }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const dismissMutation = useMutation({
    mutationFn: dismissAnnouncement,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['announcements', 'active'] }),
  });

  const config = categoryConfig[announcement.category];
  const Icon = config.icon;
  const preview = extractPreviewText(announcement.content);

  return (
    <div
      className={clsx(
        'flex items-start gap-3 px-4 py-3 border-b',
        config.bg,
        config.border
      )}
    >
      {/* Icon */}
      <div className="flex-shrink-0 mt-0.5">
        <Icon className={clsx('h-5 w-5', config.iconColor)} aria-hidden="true" />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3">
        <span className={clsx('font-semibold text-sm whitespace-nowrap', config.titleColor)}>
          {announcement.title}
        </span>
        <span className={clsx('text-sm truncate', config.textColor)}>
          {preview}
        </span>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 flex-shrink-0">
        <button
          type="button"
          onClick={() => navigate('/announcements')}
          className={clsx(
            'text-sm font-medium underline underline-offset-2',
            config.dismissColor
          )}
        >
          {t('announcements.view')}
        </button>
        <button
          type="button"
          onClick={() => dismissMutation.mutate(announcement.id)}
          disabled={dismissMutation.isPending}
          className={clsx(
            'p-1 rounded-md transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center',
            config.dismissColor
          )}
          aria-label={t('announcements.dismiss')}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

export default function AnnouncementBanner() {
  const { data: announcements } = useQuery({
    queryKey: ['announcements', 'active'],
    queryFn: getActiveAnnouncements,
    refetchInterval: 5 * 60 * 1000,
    staleTime: 60 * 1000,
  });

  if (!announcements || announcements.length === 0) {
    return null;
  }

  return (
    <div className="z-30 flex-shrink-0">
      {announcements.map((announcement) => (
        <AnnouncementItem key={announcement.id} announcement={announcement} />
      ))}
    </div>
  );
}
