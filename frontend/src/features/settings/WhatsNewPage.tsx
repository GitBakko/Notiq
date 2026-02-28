import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Menu, ChevronDown, ChevronRight, ArrowLeft } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import { useIsMobile } from '../../hooks/useIsMobile';
import { changelog } from '../../data/changelog';
import TypeBadge from '../../components/changelog/TypeBadge';

export default function WhatsNewPage() {
  const { t } = useTranslation();
  const { toggleSidebar } = useUIStore();
  const isMobile = useIsMobile();

  const [expandedVersions, setExpandedVersions] = useState<Set<string>>(() => {
    return new Set([changelog[0].version]);
  });

  function toggleVersion(version: string) {
    setExpandedVersions((prev) => {
      const next = new Set(prev);
      if (next.has(version)) {
        next.delete(version);
      } else {
        next.add(version);
      }
      return next;
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
          >
            <Menu size={24} />
          </button>
        )}
        <Link
          to="/settings"
          className="text-neutral-400 transition-colors hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300"
        >
          <ArrowLeft size={20} />
        </Link>
        <h1 className="text-2xl font-bold text-neutral-900 dark:text-white">
          {t('whatsNew.title')}
        </h1>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-8 space-y-4">
        {changelog.map((version) => {
          const isExpanded = expandedVersions.has(version.version);

          return (
            <section
              key={version.version}
              className="rounded-xl border border-neutral-200/60 bg-white dark:border-neutral-700/40 dark:bg-neutral-800"
            >
              {/* Version header */}
              <button
                onClick={() => toggleVersion(version.version)}
                className="flex w-full items-center justify-between px-6 py-4 text-left"
              >
                <div className="flex items-center gap-3">
                  <span className="rounded-full bg-emerald-100 px-3 py-1 text-sm font-semibold text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                    v{version.version}
                  </span>
                  <span className="text-sm text-neutral-500 dark:text-neutral-400">
                    {version.date}
                  </span>
                </div>
                {isExpanded ? (
                  <ChevronDown size={18} className="text-neutral-400 dark:text-neutral-500" />
                ) : (
                  <ChevronRight size={18} className="text-neutral-400 dark:text-neutral-500" />
                )}
              </button>

              {/* Entries */}
              {isExpanded && (
                <div className="border-t border-neutral-100 px-6 py-4 dark:border-neutral-700">
                  <ul className="space-y-3">
                    {version.entries.map((entry) => (
                      <li key={entry.titleKey} className="flex items-start gap-3">
                        <TypeBadge type={entry.type} />
                        <span className="text-sm text-neutral-700 dark:text-neutral-300">
                          {t(entry.titleKey)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
