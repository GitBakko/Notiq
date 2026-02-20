import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUpDown, Check, ArrowUp, ArrowDown } from 'lucide-react';
import clsx from 'clsx';
import type { SortField, SortOrder } from '../../store/uiStore';

interface SortDropdownProps {
  sortField: SortField;
  sortOrder: SortOrder;
  onChange: (field: SortField, order: SortOrder) => void;
}

const SORT_OPTIONS: { field: SortField; defaultOrder: SortOrder }[] = [
  { field: 'updatedAt', defaultOrder: 'desc' },
  { field: 'createdAt', defaultOrder: 'desc' },
  { field: 'title', defaultOrder: 'asc' },
];

export default function SortDropdown({ sortField, sortOrder, onChange }: SortDropdownProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  const handleSelect = (field: SortField, defaultOrder: SortOrder) => {
    if (field === sortField) {
      onChange(field, sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      onChange(field, defaultOrder);
    }
    setOpen(false);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className={clsx(
          'flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-colors',
          open
            ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
            : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
        )}
        title={t('notes.sort.label')}
      >
        <ArrowUpDown size={14} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg overflow-hidden min-w-[180px]">
          {SORT_OPTIONS.map(({ field, defaultOrder }) => {
            const isActive = sortField === field;
            return (
              <button
                key={field}
                onClick={() => handleSelect(field, defaultOrder)}
                className={clsx(
                  'w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400'
                    : 'text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700'
                )}
              >
                <span className="w-4 flex-shrink-0">
                  {isActive && <Check size={14} />}
                </span>
                <span className="flex-1 text-left">{t(`notes.sort.${field}`)}</span>
                {isActive && (
                  sortOrder === 'asc'
                    ? <ArrowUp size={14} className="flex-shrink-0" />
                    : <ArrowDown size={14} className="flex-shrink-0" />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
