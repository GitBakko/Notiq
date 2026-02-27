import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Plus, X, Tag as TagIcon } from 'lucide-react';
import { useTags } from '../../hooks/useTags';
import { createTag, addTagToNote, removeTagFromNote } from '../../features/tags/tagService';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { useQueryClient } from '@tanstack/react-query';

interface TagSelectorProps {
  noteId: string;
  noteTags: { tag: { id: string; name: string } }[];
  onUpdate: () => void;
  isVault?: boolean;
}

export default function TagSelector({ noteId, noteTags = [], onUpdate, isVault = false }: TagSelectorProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const { tags } = useTags(isVault);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0 });

  // Calculate dropdown position when opening
  useEffect(() => {
    if (isOpen && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setDropdownPosition({
        top: rect.bottom + window.scrollY + 8,
        left: rect.left + window.scrollX
      });
    }
  }, [isOpen]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node;
      if (
        wrapperRef.current && !wrapperRef.current.contains(target) &&
        dropdownRef.current && !dropdownRef.current.contains(target)
      ) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  const filteredTags = tags?.filter(t =>
    t.name.toLowerCase().includes(search.toLowerCase()) &&
    !noteTags.some(nt => nt.tag.id === t.id)
  ) || [];

  const handleAddTag = async (tagId: string) => {
    try {
      await addTagToNote(noteId, tagId);
      onUpdate();
      setSearch('');
      setIsOpen(false); // Close after adding
    } catch {
      toast.error(t('tags.addFailed'));
    }
  };

  const handleCreateTag = async () => {
    if (!search.trim()) return;
    try {
      const newTag = await createTag(search.trim(), isVault);
      await addTagToNote(noteId, newTag.id);
      queryClient.invalidateQueries({ queryKey: ['tags'] });
      onUpdate();
      setSearch('');
      setIsOpen(false);
      toast.success(t('tags.created'));
    } catch (error) {
      const message = error instanceof Error ? error.message : t('tags.createFailed');
      toast.error(message);
    }
  };

  const handleRemoveTag = async (tagId: string) => {
    try {
      await removeTagFromNote(noteId, tagId);
      onUpdate();
    } catch {
      toast.error(t('tags.removeFailed'));
    }
  };

  return (
    <div className="relative" ref={wrapperRef}>
      <div className="flex flex-wrap gap-2 items-center">
        {noteTags.map(t => (
          <span key={t.tag.id} className="bg-gray-100 px-2 py-1 rounded-full text-xs text-gray-600 flex items-center gap-1 dark:bg-gray-800 dark:text-gray-300">
            #{t.tag.name}
            <button onClick={() => handleRemoveTag(t.tag.id)} className="hover:text-red-500 dark:hover:text-red-400">
              <X size={12} />
            </button>
          </span>
        ))}
        <button
          ref={buttonRef}
          onClick={() => setIsOpen(!isOpen)}
          className="text-gray-400 hover:text-emerald-600 flex items-center gap-1 text-xs px-2 py-1 rounded-full border border-dashed border-gray-300 hover:border-emerald-500 dark:text-gray-500 dark:border-gray-700 dark:hover:text-emerald-400 dark:hover:border-emerald-400"
        >
          <Plus size={12} />
          {t('tags.addTag')}
        </button>
      </div>

      {isOpen && createPortal(
        <div
          ref={dropdownRef}
          className="fixed w-64 bg-white rounded-lg shadow-lg border border-gray-200 z-[9999] p-2 dark:bg-gray-900 dark:border-gray-700"
          style={{ top: dropdownPosition.top, left: dropdownPosition.left }}
        >
          <input
            type="text"
            placeholder={t('tags.searchOrCreate')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm mb-2 focus:outline-none focus:border-emerald-500 dark:bg-gray-800 dark:border-gray-700 dark:text-white dark:focus:border-emerald-400"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (filteredTags.length > 0) {
                  // If exact match exists, add it. If not, create new?
                  // Simple logic: if exact match, add. If not, create.
                  const exactMatch = filteredTags.find(t => t.name.toLowerCase() === search.toLowerCase());
                  if (exactMatch) {
                    handleAddTag(exactMatch.id);
                  } else if (search.trim()) {
                    handleCreateTag();
                  }
                } else if (search.trim()) {
                  handleCreateTag();
                }
              }
            }}
          />
          <div className="max-h-48 overflow-y-auto">
            {filteredTags.map(tag => (
              <button
                key={tag.id}
                onClick={() => handleAddTag(tag.id)}
                className="w-full text-left px-3 py-2 hover:bg-gray-50 text-sm rounded-md flex items-center gap-2 dark:text-gray-200 dark:hover:bg-gray-800"
              >
                <TagIcon size={14} className="text-gray-400 dark:text-gray-500" />
                {tag.name}
              </button>
            ))}
            {search && !filteredTags.some(t => t.name.toLowerCase() === search.toLowerCase()) && (
              <button
                onClick={handleCreateTag}
                className="w-full text-left px-3 py-2 hover:bg-emerald-50 text-emerald-700 text-sm rounded-md font-medium dark:text-emerald-400 dark:hover:bg-emerald-900/20"
              >
                {t('tags.createTag', { name: search })}
              </button>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
