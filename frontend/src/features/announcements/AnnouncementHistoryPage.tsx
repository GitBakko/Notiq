import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Megaphone, Menu, ChevronLeft, ChevronRight } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import { useIsMobile } from '../../hooks/useIsMobile';
import { getAnnouncementHistory } from './announcementService';
import type { Announcement } from './announcementService';

const ITEMS_PER_PAGE = 10;

// --- TipTap JSON to HTML helpers ---

interface TipTapNode {
  type: string;
  content?: TipTapNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, string> }[];
  attrs?: Record<string, unknown>;
}

function renderMarks(text: string, marks?: TipTapNode['marks']): string {
  if (!marks || marks.length === 0) return text;
  let result = text;
  for (const mark of marks) {
    switch (mark.type) {
      case 'bold':
        result = `<strong>${result}</strong>`;
        break;
      case 'italic':
        result = `<em>${result}</em>`;
        break;
      case 'link':
        result = `<a href="${mark.attrs?.href ?? '#'}" target="_blank" rel="noopener noreferrer" class="text-blue-600 dark:text-blue-400 underline">${result}</a>`;
        break;
      case 'code':
        result = `<code>${result}</code>`;
        break;
    }
  }
  return result;
}

function nodeToHtml(node: TipTapNode): string {
  if (node.type === 'text') {
    return renderMarks(node.text ?? '', node.marks);
  }

  const children = (node.content ?? []).map(nodeToHtml).join('');

  switch (node.type) {
    case 'doc':
      return children;
    case 'paragraph':
      return `<p>${children}</p>`;
    case 'heading': {
      const level = (node.attrs?.level as number) ?? 2;
      const tag = level <= 3 ? `h${level}` : 'h3';
      return `<${tag}>${children}</${tag}>`;
    }
    case 'bulletList':
      return `<ul>${children}</ul>`;
    case 'orderedList':
      return `<ol>${children}</ol>`;
    case 'listItem':
      return `<li>${children}</li>`;
    case 'blockquote':
      return `<blockquote>${children}</blockquote>`;
    case 'codeBlock':
      return `<pre><code>${children}</code></pre>`;
    case 'hardBreak':
      return '<br />';
    default:
      return children;
  }
}

function renderContent(content: string): string {
  try {
    const doc = JSON.parse(content) as TipTapNode;
    if (doc.type === 'doc') {
      return nodeToHtml(doc);
    }
    return content;
  } catch {
    return content;
  }
}

// --- Category badge ---

function CategoryBadge({ category }: { category: Announcement['category'] }) {
  const { t } = useTranslation();
  const colors: Record<string, string> = {
    URGENT: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400',
    MAINTENANCE: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400',
    FEATURE: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400',
  };

  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${colors[category] ?? 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400'}`}
    >
      {t(`announcements.category.${category}`)}
    </span>
  );
}

// --- Main page ---

export default function AnnouncementHistoryPage() {
  const { t } = useTranslation();
  const { toggleSidebar } = useUIStore();
  const isMobile = useIsMobile();
  const [page, setPage] = useState(1);

  const { data, isLoading } = useQuery({
    queryKey: ['announcement-history', page],
    queryFn: () => getAnnouncementHistory(page, ITEMS_PER_PAGE),
  });

  const announcements = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / ITEMS_PER_PAGE));

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  return (
    <div className="flex flex-col h-full bg-neutral-50 dark:bg-neutral-900">
      {/* Header */}
      <div className="bg-white dark:bg-neutral-800 border-b border-neutral-200/60 dark:border-neutral-700/40 px-4 py-4 sm:px-8 sm:py-6 flex items-center gap-3">
        {isMobile && (
          <button
            onClick={toggleSidebar}
            className="text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100"
            aria-label={t('common.menu')}
          >
            <Menu size={24} />
          </button>
        )}
        <Megaphone size={24} className="text-blue-600 dark:text-blue-400" />
        <h1 className="text-2xl font-bold text-neutral-900 dark:text-white">
          {t('announcements.history.title')}
        </h1>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-8">
        {isLoading ? (
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="animate-pulse rounded-xl bg-white dark:bg-neutral-800 p-6 h-32"
              />
            ))}
          </div>
        ) : announcements.length === 0 ? (
          /* Empty state */
          <div className="flex flex-col items-center justify-center py-24 text-neutral-400 dark:text-neutral-500">
            <Megaphone size={48} className="mb-4" />
            <p className="text-lg">{t('announcements.history.empty')}</p>
          </div>
        ) : (
          <>
            <div className="space-y-4 max-w-3xl mx-auto">
              {announcements.map((a) => (
                <div
                  key={a.id}
                  className="rounded-xl bg-white dark:bg-neutral-800 border border-neutral-200/60 dark:border-neutral-700/40 p-5 sm:p-6 shadow-sm"
                >
                  {/* Top row: badge + active indicator */}
                  <div className="flex items-center gap-2 mb-2">
                    <CategoryBadge category={a.category} />
                    <span
                      className={`inline-block h-2 w-2 rounded-full ${a.isActive ? 'bg-emerald-500' : 'bg-neutral-300 dark:bg-neutral-600'}`}
                      title={a.isActive ? t('announcements.history.active') : t('announcements.history.inactive')}
                    />
                  </div>

                  {/* Title */}
                  <h2 className="text-lg font-bold text-neutral-900 dark:text-white mb-1">
                    {a.title}
                  </h2>

                  {/* Date + author */}
                  <p className="text-sm text-neutral-500 dark:text-neutral-400 mb-3">
                    {formatDate(a.createdAt)}
                    {a.createdBy?.name && (
                      <>
                        {' \u2014 '}
                        {t('announcements.history.by')} {a.createdBy.name}
                      </>
                    )}
                  </p>

                  {/* Content */}
                  <div
                    className="prose prose-sm dark:prose-invert max-w-none"
                    dangerouslySetInnerHTML={{ __html: renderContent(a.content) }}
                  />
                </div>
              ))}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-4 mt-8">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="inline-flex items-center gap-1 px-3 py-2 text-sm font-medium rounded-lg
                    bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700
                    text-neutral-700 dark:text-neutral-300
                    hover:bg-neutral-50 dark:hover:bg-neutral-750
                    disabled:opacity-40 disabled:cursor-not-allowed
                    min-h-[44px]"
                  aria-label={t('announcements.history.previous')}
                >
                  <ChevronLeft size={16} />
                  {t('announcements.history.previous')}
                </button>

                <span className="text-sm text-neutral-500 dark:text-neutral-400">
                  {t('announcements.history.pageOf', { page, total: totalPages })}
                </span>

                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                  className="inline-flex items-center gap-1 px-3 py-2 text-sm font-medium rounded-lg
                    bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700
                    text-neutral-700 dark:text-neutral-300
                    hover:bg-neutral-50 dark:hover:bg-neutral-750
                    disabled:opacity-40 disabled:cursor-not-allowed
                    min-h-[44px]"
                  aria-label={t('announcements.history.next')}
                >
                  {t('announcements.history.next')}
                  <ChevronRight size={16} />
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
