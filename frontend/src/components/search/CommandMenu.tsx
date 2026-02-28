import { useEffect, useState, useMemo } from 'react';
import { Command } from 'cmdk';
import { useNavigate } from 'react-router-dom';
import { FileText, Book, Tag, Search, Plus, Trash2, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { getNotebooks } from '../../features/notebooks/notebookService';
import { getTags } from '../../features/tags/tagService';
import { searchNotes, type SearchResult } from '../../features/search/searchService';
import { useUIStore } from '../../store/uiStore';

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** Escape HTML, then replace [[HL]]/[[/HL]] markers with <mark> tags */
function renderHighlight(text: string): string {
  if (!text) return '';
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped
    .replace(/\[\[HL\]\]/g, '<mark class="bg-emerald-200 dark:bg-emerald-800 text-inherit rounded-sm px-0.5">')
    .replace(/\[\[\/HL\]\]/g, '</mark>');
}

export default function CommandMenu() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { isSearchOpen, closeSearch, toggleSearch } = useUIStore();

  // Toggle with Ctrl+K or Cmd+K
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        toggleSearch();
      }
    };

    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, [toggleSearch]);

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);

  // Reset search when menu closes
  useEffect(() => {
    if (!isSearchOpen) setSearch('');
  }, [isSearchOpen]);

  // Server-side full-text search (only when query >= 2 chars)
  const { data: searchResults, isLoading: isSearching } = useQuery({
    queryKey: ['search', debouncedSearch],
    queryFn: () => searchNotes(debouncedSearch, 1, 10),
    enabled: isSearchOpen && debouncedSearch.length >= 2,
    staleTime: 30_000,
  });

  // Client-side data for notebooks/tags (small datasets, no need for server search)
  const { data: notebooks } = useQuery({ queryKey: ['notebooks'], queryFn: getNotebooks });
  const { data: tags } = useQuery({ queryKey: ['tags'], queryFn: getTags });

  const filteredNotebooks = useMemo(() =>
    notebooks?.filter(nb => !search || nb.name.toLowerCase().includes(search.toLowerCase())).slice(0, 5),
    [notebooks, search]
  );

  const filteredTags = useMemo(() =>
    tags?.filter(tag => !search || tag.name.toLowerCase().includes(search.toLowerCase())).slice(0, 5),
    [tags, search]
  );

  const runCommand = (command: () => void) => {
    command();
    closeSearch();
  };

  if (!isSearchOpen) return null;

  const hasServerResults = debouncedSearch.length >= 2;
  const noteResults = searchResults?.results || [];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh] bg-black/20 dark:bg-black/50 backdrop-blur-sm p-4" onClick={closeSearch}>
      <Command
        className="w-full max-w-2xl overflow-hidden rounded-xl border border-neutral-200/60 dark:border-neutral-700/40 bg-white dark:bg-neutral-900 shadow-2xl animate-in fade-in zoom-in-95 duration-100"
        loop
        onClick={(e) => e.stopPropagation()}
        shouldFilter={false}
      >
        <div className="flex items-center border-b border-neutral-100 dark:border-neutral-800 px-3" cmdk-input-wrapper="">
          <Search className="mr-2 h-4 w-4 shrink-0 opacity-50 text-neutral-500 dark:text-neutral-400" />
          <Command.Input
            placeholder={t('common.searchPlaceholder')}
            value={search}
            onValueChange={setSearch}
            className="flex h-12 w-full rounded-lg bg-transparent py-3 text-sm outline-none text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 dark:placeholder:text-neutral-500 disabled:cursor-not-allowed disabled:opacity-50 caret-emerald-500"
          />
          {isSearching && <Loader2 className="h-4 w-4 animate-spin text-neutral-400" />}
        </div>

        <Command.List className="max-h-[300px] overflow-y-auto overflow-x-hidden p-2">
          <Command.Empty className="py-6 text-center text-sm text-neutral-500 dark:text-neutral-400">
            {hasServerResults && !isSearching
              ? t('search.noResults')
              : t('common.typeToSearch')}
          </Command.Empty>

          {/* Server-side search results */}
          {hasServerResults && noteResults.length > 0 && (
            <Command.Group
              heading={
                searchResults
                  ? `${t('sidebar.notes')} (${searchResults.total})`
                  : t('sidebar.notes')
              }
              className="[&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-neutral-500 [&_[cmdk-group-heading]]:dark:text-neutral-400 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
            >
              {noteResults.map((result: SearchResult) => (
                <Command.Item
                  key={result.id}
                  value={`note-${result.id}`}
                  onSelect={() => runCommand(() => navigate(`/notes?noteId=${result.id}`))}
                  className="relative flex cursor-pointer select-none flex-col rounded-sm px-2 py-1.5 text-sm outline-none text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 aria-selected:bg-emerald-100 dark:aria-selected:bg-emerald-900/50 aria-selected:text-emerald-900 dark:aria-selected:text-emerald-100"
                >
                  <div className="flex items-center gap-2">
                    <FileText className="h-4 w-4 shrink-0" />
                    <span
                      className="truncate"
                      dangerouslySetInnerHTML={{ __html: renderHighlight(result.titleHighlight) }}
                    />
                    {result.notebookName && (
                      <span className="ml-auto text-xs text-neutral-400 dark:text-neutral-500 shrink-0">
                        {result.notebookName}
                      </span>
                    )}
                  </div>
                  {result.contentHighlight && (
                    <span
                      className="ml-6 text-xs text-neutral-400 dark:text-neutral-500 truncate"
                      dangerouslySetInnerHTML={{ __html: renderHighlight(result.contentHighlight) }}
                    />
                  )}
                </Command.Item>
              ))}
            </Command.Group>
          )}

          {/* Client-side notebook/tag filtering (always available) */}
          {filteredNotebooks && filteredNotebooks.length > 0 && (
            <Command.Group heading={t('sidebar.notebooks')} className="[&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-neutral-500 [&_[cmdk-group-heading]]:dark:text-neutral-400 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
              {filteredNotebooks.map((notebook) => (
                <Command.Item
                  key={notebook.id}
                  value={`notebook-${notebook.id}`}
                  onSelect={() => runCommand(() => navigate(`/notes?notebookId=${notebook.id}`))}
                  className="relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 aria-selected:bg-emerald-100 dark:aria-selected:bg-emerald-900/50 aria-selected:text-emerald-900 dark:aria-selected:text-emerald-100"
                >
                  <Book className="mr-2 h-4 w-4" />
                  <span>{notebook.name}</span>
                </Command.Item>
              ))}
            </Command.Group>
          )}

          {filteredTags && filteredTags.length > 0 && (
            <Command.Group heading={t('sidebar.tags')} className="[&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-neutral-500 [&_[cmdk-group-heading]]:dark:text-neutral-400 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
              {filteredTags.map((tag) => (
                <Command.Item
                  key={tag.id}
                  value={`tag-${tag.id}`}
                  onSelect={() => runCommand(() => navigate(`/notes?tagId=${tag.id}`))}
                  className="relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 aria-selected:bg-emerald-100 dark:aria-selected:bg-emerald-900/50 aria-selected:text-emerald-900 dark:aria-selected:text-emerald-100"
                >
                  <Tag className="mr-2 h-4 w-4" />
                  <span>{tag.name}</span>
                </Command.Item>
              ))}
            </Command.Group>
          )}

          <Command.Separator className="my-1 h-px bg-neutral-100 dark:bg-neutral-800" />

          <Command.Group heading={t('common.actions')} className="[&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-neutral-500 [&_[cmdk-group-heading]]:dark:text-neutral-400 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
            <Command.Item
              value="new-note"
              onSelect={() => runCommand(() => navigate('/notes'))}
              className="relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 aria-selected:bg-emerald-100 dark:aria-selected:bg-emerald-900/50 aria-selected:text-emerald-900 dark:aria-selected:text-emerald-100"
            >
              <Plus className="mr-2 h-4 w-4" />
              <span>{t('notes.newNote')}</span>
            </Command.Item>
            <Command.Item
              value="create-notebook"
              onSelect={() => runCommand(() => navigate('/notebooks'))}
              className="relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 aria-selected:bg-emerald-100 dark:aria-selected:bg-emerald-900/50 aria-selected:text-emerald-900 dark:aria-selected:text-emerald-100"
            >
              <Book className="mr-2 h-4 w-4" />
              <span>{t('notebooks.create')}</span>
            </Command.Item>
            <Command.Item
              value="open-trash"
              onSelect={() => runCommand(() => navigate('/trash'))}
              className="relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 aria-selected:bg-emerald-100 dark:aria-selected:bg-emerald-900/50 aria-selected:text-emerald-900 dark:aria-selected:text-emerald-100"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              <span>{t('sidebar.trash')}</span>
            </Command.Item>
          </Command.Group>
        </Command.List>

        {/* Footer hint */}
        <div className="flex items-center justify-between border-t border-neutral-100 dark:border-neutral-800 px-3 py-2 text-xs text-neutral-400 dark:text-neutral-500">
          <span>{t('search.hint')}</span>
          <span>{t('common.escToClose')}</span>
        </div>
      </Command>
    </div>
  );
}
