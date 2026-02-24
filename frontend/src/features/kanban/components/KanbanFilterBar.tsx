import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, X, User, Calendar, FileText, MessageSquare, Download, ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import { isToday, isPast, startOfDay, isFuture } from 'date-fns';
import type { KanbanCard } from '../types';

// ── Filter types ────────────────────────────────────────────────────────

export interface KanbanFilters {
  search: string;
  assigneeIds: string[];
  dueDate: 'all' | 'overdue' | 'today' | 'upcoming' | 'none';
  hasNote: 'all' | 'yes' | 'no';
  hasComments: 'all' | 'yes' | 'no';
}

export const defaultKanbanFilters: KanbanFilters = {
  search: '',
  assigneeIds: [],
  dueDate: 'all',
  hasNote: 'all',
  hasComments: 'all',
};

export function isFiltersActive(filters: KanbanFilters): boolean {
  return (
    filters.search.trim() !== '' ||
    filters.assigneeIds.length > 0 ||
    filters.dueDate !== 'all' ||
    filters.hasNote !== 'all' ||
    filters.hasComments !== 'all'
  );
}

export function cardMatchesFilters(card: KanbanCard, filters: KanbanFilters): boolean {
  // Search
  if (filters.search.trim()) {
    const q = filters.search.toLowerCase();
    const matchTitle = card.title.toLowerCase().includes(q);
    const matchDesc = card.description?.toLowerCase().includes(q) ?? false;
    if (!matchTitle && !matchDesc) return false;
  }

  // Assignee
  if (filters.assigneeIds.length > 0) {
    const wantsUnassigned = filters.assigneeIds.includes('__unassigned__');
    const specificIds = filters.assigneeIds.filter((id) => id !== '__unassigned__');
    const matchesSpecific = card.assigneeId && specificIds.includes(card.assigneeId);
    const matchesUnassigned = wantsUnassigned && !card.assigneeId;
    if (!matchesSpecific && !matchesUnassigned) return false;
  }

  // Due date
  if (filters.dueDate !== 'all') {
    if (filters.dueDate === 'none') {
      if (card.dueDate) return false;
    } else {
      if (!card.dueDate) return false;
      const due = startOfDay(new Date(card.dueDate));
      if (filters.dueDate === 'overdue' && !(isPast(due) && !isToday(due))) return false;
      if (filters.dueDate === 'today' && !isToday(due)) return false;
      if (filters.dueDate === 'upcoming' && !isFuture(due)) return false;
    }
  }

  // Has note
  if (filters.hasNote === 'yes' && !card.noteId) return false;
  if (filters.hasNote === 'no' && card.noteId) return false;

  // Has comments
  if (filters.hasComments === 'yes' && card.commentCount === 0) return false;
  if (filters.hasComments === 'no' && card.commentCount > 0) return false;

  return true;
}

// ── Component ───────────────────────────────────────────────────────────

interface Assignee {
  id: string;
  name: string | null;
  email: string;
  color: string | null;
}

interface KanbanFilterBarProps {
  filters: KanbanFilters;
  onFiltersChange: (filters: KanbanFilters) => void;
  assignees: Assignee[];
  onExport: () => void;
}

export default function KanbanFilterBar({
  filters,
  onFiltersChange,
  assignees,
  onExport,
}: KanbanFilterBarProps) {
  const { t } = useTranslation();
  const [showAssigneeMenu, setShowAssigneeMenu] = useState(false);
  const [showDueDateMenu, setShowDueDateMenu] = useState(false);
  const assigneeRef = useRef<HTMLDivElement>(null);
  const dueDateRef = useRef<HTMLDivElement>(null);

  const active = isFiltersActive(filters);

  // Close dropdowns on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (assigneeRef.current && !assigneeRef.current.contains(e.target as Node)) {
        setShowAssigneeMenu(false);
      }
      if (dueDateRef.current && !dueDateRef.current.contains(e.target as Node)) {
        setShowDueDateMenu(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  function updateFilter<K extends keyof KanbanFilters>(key: K, value: KanbanFilters[K]) {
    onFiltersChange({ ...filters, [key]: value });
  }

  function toggleAssignee(id: string) {
    const current = filters.assigneeIds;
    const next = current.includes(id)
      ? current.filter((a) => a !== id)
      : [...current, id];
    updateFilter('assigneeIds', next);
  }

  function cycleTriState(key: 'hasNote' | 'hasComments') {
    const order: Array<'all' | 'yes' | 'no'> = ['all', 'yes', 'no'];
    const idx = order.indexOf(filters[key]);
    updateFilter(key, order[(idx + 1) % 3]);
  }

  const dueDateOptions: { value: KanbanFilters['dueDate']; labelKey: string }[] = [
    { value: 'all', labelKey: 'kanban.filters.dueDateAll' },
    { value: 'overdue', labelKey: 'kanban.filters.dueDateOverdue' },
    { value: 'today', labelKey: 'kanban.filters.dueDateToday' },
    { value: 'upcoming', labelKey: 'kanban.filters.dueDateUpcoming' },
    { value: 'none', labelKey: 'kanban.filters.dueDateNone' },
  ];

  const activeDueDateLabel = dueDateOptions.find((o) => o.value === filters.dueDate);

  return (
    <div className="flex-shrink-0 border-b border-gray-200 dark:border-gray-800 px-4 py-2">
      <div className="flex items-center gap-2 flex-wrap">
        {/* Search */}
        <div className="relative flex-shrink-0 w-48">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500" size={14} />
          <input
            type="text"
            value={filters.search}
            onChange={(e) => updateFilter('search', e.target.value)}
            placeholder={t('kanban.filters.searchPlaceholder')}
            className="w-full pl-8 pr-7 py-1.5 text-sm bg-gray-100 dark:bg-gray-800 border border-transparent focus:border-emerald-500 dark:focus:border-emerald-400 rounded-lg text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 outline-none transition-colors"
          />
          {filters.search && (
            <button
              onClick={() => updateFilter('search', '')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            >
              <X size={12} />
            </button>
          )}
        </div>

        {/* Divider */}
        <div className="w-px h-6 bg-gray-200 dark:bg-gray-700 flex-shrink-0" />

        {/* Assignee dropdown */}
        <div ref={assigneeRef} className="relative flex-shrink-0">
          <button
            onClick={() => {
              setShowAssigneeMenu(!showAssigneeMenu);
              setShowDueDateMenu(false);
            }}
            className={clsx(
              'flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors',
              filters.assigneeIds.length > 0
                ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:border-gray-600',
            )}
          >
            <User size={13} />
            {t('kanban.filters.assignee')}
            {filters.assigneeIds.length > 0 && (
              <span className="ml-0.5 bg-emerald-200 dark:bg-emerald-800 text-emerald-800 dark:text-emerald-200 rounded-full px-1.5 text-[10px] font-bold">
                {filters.assigneeIds.length}
              </span>
            )}
            <ChevronDown size={12} />
          </button>

          {showAssigneeMenu && (
            <div className="absolute left-0 top-full mt-1 z-30 w-56 max-h-64 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg py-1">
              {assignees.length === 0 ? (
                <p className="px-3 py-2 text-xs text-gray-400 dark:text-gray-500 italic">
                  {t('kanban.filters.noAssignees')}
                </p>
              ) : (
                <>
                  {assignees.map((a) => (
                    <button
                      key={a.id}
                      onClick={() => toggleAssignee(a.id)}
                      className="flex items-center gap-2 w-full px-3 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
                    >
                      <span
                        className={clsx(
                          'w-4 h-4 rounded border-2 flex items-center justify-center text-[9px] font-bold transition-colors',
                          filters.assigneeIds.includes(a.id)
                            ? 'border-emerald-500 bg-emerald-500 text-white'
                            : 'border-gray-300 dark:border-gray-600',
                        )}
                      >
                        {filters.assigneeIds.includes(a.id) && '✓'}
                      </span>
                      <span
                        className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0"
                        style={{ backgroundColor: a.color || '#6b7280' }}
                      >
                        {(a.name || a.email).charAt(0).toUpperCase()}
                      </span>
                      <span className="text-gray-700 dark:text-gray-300 truncate">
                        {a.name || a.email.split('@')[0]}
                      </span>
                    </button>
                  ))}
                  {/* Unassigned option */}
                  <div className="border-t border-gray-100 dark:border-gray-700 mt-1 pt-1">
                    <button
                      onClick={() => {
                        // Special: filter for unassigned cards
                        // We handle this by adding a sentinel value
                        toggleAssignee('__unassigned__');
                      }}
                      className="flex items-center gap-2 w-full px-3 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
                    >
                      <span
                        className={clsx(
                          'w-4 h-4 rounded border-2 flex items-center justify-center text-[9px] font-bold transition-colors',
                          filters.assigneeIds.includes('__unassigned__')
                            ? 'border-emerald-500 bg-emerald-500 text-white'
                            : 'border-gray-300 dark:border-gray-600',
                        )}
                      >
                        {filters.assigneeIds.includes('__unassigned__') && '✓'}
                      </span>
                      <span className="w-5 h-5 rounded-full bg-gray-300 dark:bg-gray-600 flex items-center justify-center text-[10px] text-gray-500 dark:text-gray-400 flex-shrink-0">
                        ?
                      </span>
                      <span className="text-gray-500 dark:text-gray-400 italic">
                        {t('kanban.filters.unassigned')}
                      </span>
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Due date dropdown */}
        <div ref={dueDateRef} className="relative flex-shrink-0">
          <button
            onClick={() => {
              setShowDueDateMenu(!showDueDateMenu);
              setShowAssigneeMenu(false);
            }}
            className={clsx(
              'flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors',
              filters.dueDate !== 'all'
                ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:border-gray-600',
            )}
          >
            <Calendar size={13} />
            {filters.dueDate === 'all'
              ? t('kanban.filters.dueDate')
              : t(activeDueDateLabel?.labelKey || '')}
            <ChevronDown size={12} />
          </button>

          {showDueDateMenu && (
            <div className="absolute left-0 top-full mt-1 z-30 w-48 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg py-1">
              {dueDateOptions.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => {
                    updateFilter('dueDate', opt.value);
                    setShowDueDateMenu(false);
                  }}
                  className={clsx(
                    'flex items-center gap-2 w-full px-3 py-1.5 text-sm transition-colors',
                    filters.dueDate === opt.value
                      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                      : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50',
                  )}
                >
                  {filters.dueDate === opt.value && (
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0" />
                  )}
                  {t(opt.labelKey)}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Has note toggle */}
        <button
          onClick={() => cycleTriState('hasNote')}
          title={
            filters.hasNote === 'all'
              ? t('kanban.filters.noteAll')
              : filters.hasNote === 'yes'
                ? t('kanban.filters.noteLinked')
                : t('kanban.filters.noteNotLinked')
          }
          className={clsx(
            'flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors flex-shrink-0',
            filters.hasNote === 'all' &&
              'border-gray-200 bg-white text-gray-500 hover:border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:border-gray-600',
            filters.hasNote === 'yes' &&
              'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
            filters.hasNote === 'no' &&
              'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
          )}
        >
          <FileText size={13} />
          {filters.hasNote === 'yes' && t('kanban.filters.noteLinked')}
          {filters.hasNote === 'no' && t('kanban.filters.noteNotLinked')}
        </button>

        {/* Has comments toggle */}
        <button
          onClick={() => cycleTriState('hasComments')}
          title={
            filters.hasComments === 'all'
              ? t('kanban.filters.commentsAll')
              : filters.hasComments === 'yes'
                ? t('kanban.filters.commentsHas')
                : t('kanban.filters.commentsNone')
          }
          className={clsx(
            'flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors flex-shrink-0',
            filters.hasComments === 'all' &&
              'border-gray-200 bg-white text-gray-500 hover:border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:border-gray-600',
            filters.hasComments === 'yes' &&
              'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
            filters.hasComments === 'no' &&
              'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
          )}
        >
          <MessageSquare size={13} />
          {filters.hasComments === 'yes' && t('kanban.filters.commentsHas')}
          {filters.hasComments === 'no' && t('kanban.filters.commentsNone')}
        </button>

        {/* Clear all */}
        {active && (
          <button
            onClick={() => onFiltersChange(defaultKanbanFilters)}
            className="flex items-center gap-1 px-2 py-1.5 text-xs font-medium text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 transition-colors flex-shrink-0"
            title={t('kanban.filters.clearAll')}
          >
            <X size={13} />
            {t('kanban.filters.clearAll')}
          </button>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Export CSV */}
        <button
          onClick={onExport}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:text-gray-800 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:border-gray-600 dark:hover:text-gray-200 transition-colors flex-shrink-0"
          title={t('kanban.export.ganttCsv')}
        >
          <Download size={13} />
          {t('kanban.export.ganttCsv')}
        </button>
      </div>
    </div>
  );
}
