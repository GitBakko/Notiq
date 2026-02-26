import { useState } from 'react';
import { Command } from 'cmdk';
import * as Popover from '@radix-ui/react-popover';
import { Book, Check, ChevronsUpDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import type { Notebook } from '../../features/notebooks/notebookService';

interface NotebookSelectorProps {
  notebooks: Notebook[];
  selectedNotebookId: string;
  onSelect: (notebookId: string) => void;
  className?: string;
}

export default function NotebookSelector({ notebooks = [], selectedNotebookId, onSelect, className }: NotebookSelectorProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const selectedNotebook = notebooks?.find(n => n.id === selectedNotebookId);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          role="combobox"
          aria-expanded={open}
          className={clsx(
            "flex items-center gap-2 text-sm font-medium transition-colors hover:text-emerald-600 dark:hover:text-emerald-400",
            className
          )}
        >
          <Book size={16} className="text-gray-400 dark:text-gray-500" />
          <span className="truncate max-w-[150px]">{selectedNotebook?.name || t('notes.selectNotebook')}</span>
          <ChevronsUpDown size={14} className="text-gray-400" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="z-50 w-[200px] p-0 bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 overflow-hidden" align="start">
          <Command className="w-full">
            <div className="flex items-center border-b border-gray-100 dark:border-gray-700 px-3" cmdk-input-wrapper="">
              <Command.Input
                placeholder={t('notes.searchNotebooks')}
                className="flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-gray-400 disabled:cursor-not-allowed disabled:opacity-50 dark:text-white"
              />
            </div>
            <Command.List className="max-h-[300px] overflow-y-auto overflow-x-hidden p-1">
              <Command.Empty className="py-6 text-center text-sm text-gray-500 dark:text-gray-400">
                {t('notes.noNotebooksFound')}
              </Command.Empty>
              <Command.Group>
                {notebooks.map((notebook) => (
                  <Command.Item
                    key={notebook.id}
                    value={notebook.name}
                    onSelect={() => {
                      onSelect(notebook.id);
                      setOpen(false);
                    }}
                    className={clsx(
                      "relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none aria-selected:bg-emerald-50 aria-selected:text-emerald-900 dark:aria-selected:bg-emerald-900/30 dark:aria-selected:text-emerald-100 dark:text-gray-200",
                      selectedNotebookId === notebook.id && "bg-emerald-50 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-100"
                    )}
                  >
                    <Check
                      className={clsx(
                        "mr-2 h-4 w-4",
                        selectedNotebookId === notebook.id ? "opacity-100" : "opacity-0"
                      )}
                    />
                    {notebook.name}
                  </Command.Item>
                ))}
              </Command.Group>
            </Command.List>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
