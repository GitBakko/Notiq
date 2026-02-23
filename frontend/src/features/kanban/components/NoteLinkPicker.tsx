import { useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Search, FileText, X, Book } from 'lucide-react';
import Modal from '../../../components/ui/Modal';
import * as kanbanService from '../kanbanService';
import type { NoteSearchResult } from '../types';

interface NoteLinkPickerProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (note: NoteSearchResult) => void;
}

export default function NoteLinkPicker({ isOpen, onClose, onSelect }: NoteLinkPickerProps) {
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchQuery), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Focus input when modal opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 100);
      setSearchQuery('');
      setDebouncedQuery('');
    }
  }, [isOpen]);

  const { data: notes, isLoading } = useQuery({
    queryKey: ['kanban-note-search', debouncedQuery],
    queryFn: () => kanbanService.searchNotes(debouncedQuery),
    enabled: isOpen,
  });

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('kanban.noteLink.pickerTitle')} size="md">
      <div className="space-y-4">
        {/* Search input */}
        <div className="relative">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500"
          />
          <input
            ref={inputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('kanban.noteLink.searchPlaceholder')}
            className="w-full pl-9 pr-8 py-2 text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 outline-none focus:border-emerald-500 dark:focus:border-emerald-500"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            >
              <X size={14} />
            </button>
          )}
        </div>

        {/* Results */}
        <div className="max-h-64 overflow-y-auto space-y-1">
          {isLoading ? (
            <div className="flex justify-center py-8">
              <div className="w-5 h-5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : notes && notes.length > 0 ? (
            notes.map((note) => (
              <button
                key={note.id}
                onClick={() => onSelect(note)}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              >
                <FileText size={16} className="text-emerald-500 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                    {note.title || t('kanban.noteLink.untitledNote')}
                  </p>
                  {note.notebook && (
                    <p className="flex items-center gap-1 text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                      <Book size={10} />
                      {note.notebook.name}
                    </p>
                  )}
                </div>
              </button>
            ))
          ) : (
            <p className="text-center text-sm text-gray-400 dark:text-gray-500 py-8">
              {searchQuery
                ? t('kanban.noteLink.noResults')
                : t('kanban.noteLink.typeToSearch')}
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}
