import { useEffect, useState } from 'react';
import { Command } from 'cmdk';
import { useNavigate } from 'react-router-dom';
import { FileText, Book, Tag, Search, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { getNotes } from '../../features/notes/noteService';
import { getNotebooks } from '../../features/notebooks/notebookService';
import { getTags } from '../../features/tags/tagService';
import { useUIStore } from '../../store/uiStore';

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

  // Fetch data
  const { data: notes } = useQuery({ queryKey: ['notes'], queryFn: () => getNotes() });
  const { data: notebooks } = useQuery({ queryKey: ['notebooks'], queryFn: getNotebooks });
  const { data: tags } = useQuery({ queryKey: ['tags'], queryFn: getTags });

  const [search, setSearch] = useState('');

  // Filter and slice data
  const filteredNotes = notes
    ?.filter(note => !search || note.title.toLowerCase().includes(search.toLowerCase()))
    .slice(0, 5);

  const filteredNotebooks = notebooks
    ?.filter(notebook => !search || notebook.name.toLowerCase().includes(search.toLowerCase()))
    .slice(0, 5);

  const filteredTags = tags
    ?.filter(tag => !search || tag.name.toLowerCase().includes(search.toLowerCase()))
    .slice(0, 5);

  const runCommand = (command: () => void) => {
    command();
    closeSearch();
  };

  if (!isSearchOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh] bg-black/20 dark:bg-black/50 backdrop-blur-sm p-4" onClick={closeSearch}>
      <Command
        className="w-full max-w-2xl overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-2xl animate-in fade-in zoom-in-95 duration-100"
        loop
        onClick={(e) => e.stopPropagation()}
        shouldFilter={false}
      >
        <div className="flex items-center border-b border-gray-100 dark:border-gray-800 px-3" cmdk-input-wrapper="">
          <Search className="mr-2 h-4 w-4 shrink-0 opacity-50 text-gray-500 dark:text-gray-400" />
          <Command.Input
            placeholder={t('common.searchPlaceholder')}
            value={search}
            onValueChange={setSearch}
            className="flex h-12 w-full rounded-md bg-transparent py-3 text-sm outline-none text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 disabled:cursor-not-allowed disabled:opacity-50 caret-emerald-500"
          />
        </div>

        <Command.List className="max-h-[300px] overflow-y-auto overflow-x-hidden p-2">
          <Command.Empty className="py-6 text-center text-sm text-gray-500 dark:text-gray-400">
            {t('common.noResults')}
          </Command.Empty>

          {filteredNotes && filteredNotes.length > 0 && (
            <Command.Group heading={t('sidebar.notes')} className="[&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-gray-500 [&_[cmdk-group-heading]]:dark:text-gray-400 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
              {filteredNotes.map((note) => (
                <Command.Item
                  key={note.id}
                  onSelect={() => runCommand(() => navigate(`/notes?noteId=${note.id}`))}
                  className="relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none text-gray-700 dark:text-gray-200 aria-selected:bg-emerald-100 dark:aria-selected:bg-emerald-900/50 aria-selected:text-emerald-900 dark:aria-selected:text-emerald-100 data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
                >
                  <FileText className="mr-2 h-4 w-4" />
                  <span>{note.title || t('notes.untitled')}</span>
                </Command.Item>
              ))}
            </Command.Group>
          )}

          {filteredNotebooks && filteredNotebooks.length > 0 && (
            <Command.Group heading={t('sidebar.notebooks')} className="[&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-gray-500 [&_[cmdk-group-heading]]:dark:text-gray-400 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
              {filteredNotebooks.map((notebook) => (
                <Command.Item
                  key={notebook.id}
                  onSelect={() => runCommand(() => navigate(`/notes?notebookId=${notebook.id}`))}
                  className="relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none text-gray-700 dark:text-gray-200 aria-selected:bg-emerald-100 dark:aria-selected:bg-emerald-900/50 aria-selected:text-emerald-900 dark:aria-selected:text-emerald-100 data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
                >
                  <Book className="mr-2 h-4 w-4" />
                  <span>{notebook.name}</span>
                </Command.Item>
              ))}
            </Command.Group>
          )}

          {filteredTags && filteredTags.length > 0 && (
            <Command.Group heading={t('sidebar.tags')} className="[&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-gray-500 [&_[cmdk-group-heading]]:dark:text-gray-400 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
              {filteredTags.map((tag) => (
                <Command.Item
                  key={tag.id}
                  onSelect={() => runCommand(() => navigate(`/notes?tagId=${tag.id}`))}
                  className="relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none text-gray-700 dark:text-gray-200 aria-selected:bg-emerald-100 dark:aria-selected:bg-emerald-900/50 aria-selected:text-emerald-900 dark:aria-selected:text-emerald-100 data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
                >
                  <Tag className="mr-2 h-4 w-4" />
                  <span>{tag.name}</span>
                </Command.Item>
              ))}
            </Command.Group>
          )}

          <Command.Separator className="my-1 h-px bg-gray-100 dark:bg-gray-800" />

          <Command.Group heading={t('common.actions')} className="[&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-gray-500 [&_[cmdk-group-heading]]:dark:text-gray-400 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
            <Command.Item
              onSelect={() => runCommand(() => navigate('/notes'))}
              className="relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none text-gray-700 dark:text-gray-200 aria-selected:bg-emerald-100 dark:aria-selected:bg-emerald-900/50 aria-selected:text-emerald-900 dark:aria-selected:text-emerald-100"
            >
              <Plus className="mr-2 h-4 w-4" />
              <span>{t('notes.newNote')}</span>
            </Command.Item>
            <Command.Item
              onSelect={() => runCommand(() => navigate('/notebooks'))}
              className="relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none text-gray-700 dark:text-gray-200 aria-selected:bg-emerald-100 dark:aria-selected:bg-emerald-900/50 aria-selected:text-emerald-900 dark:aria-selected:text-emerald-100"
            >
              <Book className="mr-2 h-4 w-4" />
              <span>{t('notebooks.create')}</span>
            </Command.Item>
            <Command.Item
              onSelect={() => runCommand(() => navigate('/trash'))}
              className="relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none text-gray-700 dark:text-gray-200 aria-selected:bg-emerald-100 dark:aria-selected:bg-emerald-900/50 aria-selected:text-emerald-900 dark:aria-selected:text-emerald-100"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              <span>{t('sidebar.trash')}</span>
            </Command.Item>
          </Command.Group>
        </Command.List>
      </Command>
    </div>
  );
}
