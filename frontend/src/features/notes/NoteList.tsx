import { useTranslation } from 'react-i18next';
import { formatDistanceToNow } from 'date-fns';
import { it, enUS } from 'date-fns/locale';
import { type Note } from './noteService';
import clsx from 'clsx';
import { Tag, Paperclip, Bell, CheckCircle, Globe, Users } from 'lucide-react';

interface NoteListProps {
  notes: Note[];
  selectedNoteId: string | null;
  onSelectNote: (id: string) => void;
}

export default function NoteList({ notes, selectedNoteId, onSelectNote }: NoteListProps) {
  const { t, i18n } = useTranslation();
  const dateLocale = i18n.language.startsWith('it') ? it : enUS;

  const extractTextFromContent = (content: string): string => {
    if (!content) return '';
    try {
      // Try to parse as JSON
      const json = JSON.parse(content);
      if (typeof json === 'object' && json !== null) {
        // Recursive function to extract text
        const getText = (node: any): string => {
          if (node.type === 'text' && node.text) {
            return node.text;
          }
          if (node.content && Array.isArray(node.content)) {
            return node.content.map(getText).join(' ');
          }
          return '';
        };
        return getText(json);
      }
    } catch (e) {
      // Not JSON, treat as HTML string
      return content.replace(/<[^>]*>?/gm, '');
    }
    return content.replace(/<[^>]*>?/gm, '');
  };

  // Debug content if preview is empty but content exists
  const getPreviewText = (content: string) => {
    const text = extractTextFromContent(content);
    if (!text && content && content.length > 20) {
      // console.log('NoteList: Empty preview for content:', content.substring(0, 100));
    }
    return text;
  };

  if (!notes || notes.length === 0) {
    return <div className="p-4 text-gray-500 text-sm text-center mt-10 dark:text-gray-400">{t('notes.noNotesFound')}</div>;
  }

  return (
    <div className="flex-1 overflow-y-auto bg-white dark:bg-gray-900">
      {notes.map((note) => (
        <div
          key={note.id}
          onClick={() => onSelectNote(note.id)}
          className={clsx(
            'cursor-pointer border-b border-gray-100 p-4 transition-colors hover:bg-gray-50 group dark:border-gray-800 dark:hover:bg-gray-800',
            selectedNoteId === note.id ? 'bg-emerald-50 border-l-4 border-l-emerald-500 dark:bg-emerald-900/20' : 'border-l-4 border-l-transparent pl-5'
          )}
        >
          <div className="flex items-center gap-2 mb-1">
            <h3 className={clsx('text-sm font-semibold truncate flex-1', selectedNoteId === note.id ? 'text-emerald-900 dark:text-emerald-400' : 'text-gray-900 dark:text-white')}>
              {note.title || t('notes.untitled')}
            </h3>
            {note.notebook && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400 whitespace-nowrap">
                {note.notebook.name}
              </span>
            )}
            {note.ownership === 'shared' && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 whitespace-nowrap flex items-center gap-0.5">
                <Users size={10} />
                {note.sharedPermission === 'WRITE' ? t('sharing.readWrite') : t('sharing.readOnly')}
              </span>
            )}
          </div>
          <p className="mb-2 line-clamp-2 text-xs text-gray-500 h-8 dark:text-gray-400">
            {note.content ? getPreviewText(note.content) : (note.searchText || t('notes.noContent'))}
          </p>
          <div className="flex items-center justify-between text-xs text-gray-400 dark:text-gray-500">
            <div className="flex items-center gap-2">
              <span>{formatDistanceToNow(new Date(note.updatedAt), { addSuffix: true, locale: dateLocale })}</span>
              {note.ownership === 'shared' && note.sharedByUser && (
                <span className="text-[10px] text-blue-500 dark:text-blue-400 truncate max-w-[120px]">
                  {t('notes.sharedBy', { name: note.sharedByUser.name || note.sharedByUser.email })}
                </span>
              )}
              {note.reminderDate && (
                <span className={clsx("flex items-center gap-1", note.isReminderDone ? "text-emerald-500" : "text-amber-500")} title={new Date(note.reminderDate).toLocaleString()}>
                  {note.isReminderDone ? <CheckCircle size={12} /> : <Bell size={12} />}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {note.isPublic && (
                <Globe size={12} className="text-emerald-500" />
              )}
              {note.sharedWith && note.sharedWith.length > 0 && (
                <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400" title={`${note.sharedWith.length} users`}>
                  <Users size={12} />
                  <span className="text-[10px] font-medium">{note.sharedWith.length}</span>
                </span>
              )}
              {note.attachments && note.attachments.length > 0 && (
                <span className="flex items-center gap-1 bg-gray-100 px-1.5 py-0.5 rounded text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                  <Paperclip size={10} />
                  <span className="text-[10px]">{note.attachments.length}</span>
                </span>
              )}
              {note.tags && note.tags.length > 0 && (
                <span className="flex items-center gap-1 bg-gray-100 px-1.5 py-0.5 rounded text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                  <Tag size={10} />
                  <span className="text-[10px]">{note.tags.length}</span>
                </span>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
