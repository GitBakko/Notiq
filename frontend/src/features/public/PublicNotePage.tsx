import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getPublicNote, type Note } from '../notes/noteService';
import Editor from '../../components/editor/Editor';
import AttachmentList from '../../components/editor/AttachmentList';
import { useTranslation } from 'react-i18next';
import { formatDistanceToNow } from 'date-fns';

export default function PublicNotePage() {
  const { t } = useTranslation();
  const { noteId } = useParams<{ noteId: string }>();
  const [note, setNote] = useState<Note | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (noteId) {
      getPublicNote(noteId)
        .then(setNote)
        .catch(() => setError('Note not found or is private'))
        .finally(() => setLoading(false));
    }
  }, [noteId]);

  if (loading) return <div className="flex h-screen items-center justify-center dark:bg-gray-900 dark:text-white">{t('common.loading')}</div>;
  if (error || !note) return <div className="flex h-screen items-center justify-center text-red-500 dark:bg-gray-900 dark:text-red-400">{error || t('common.notFound')}</div>;

  return (
    <div className="h-screen overflow-y-auto bg-gray-50 py-12 px-4 sm:px-6 lg:px-8 dark:bg-gray-900">
      <div className="max-w-4xl mx-auto bg-white rounded-lg shadow-lg overflow-hidden dark:bg-gray-800">
        <div className="p-8 border-b border-gray-200 dark:border-gray-700">
          <h1 className="text-3xl font-bold text-gray-900 mb-2 dark:text-white">{note.title}</h1>
          <div className="flex items-center gap-4 text-sm text-gray-500 dark:text-gray-400">
            <span>{t('common.lastEdited')} {formatDistanceToNow(new Date(note.updatedAt), { addSuffix: true })}</span>
            {note.tags && note.tags.length > 0 && (
              <div className="flex gap-1">
                {note.tags.map(t => (
                  <span key={t.tag.id} className="bg-gray-100 px-2 py-0.5 rounded text-gray-600 dark:bg-gray-700 dark:text-gray-300">#{t.tag.name}</span>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="p-8 min-h-[400px]">
          <Editor content={note.content} onChange={() => { }} editable={false} scrollable={false} />
        </div>

        {note.attachments && note.attachments.length > 0 && (
          <div className="px-8 pb-8 border-t border-gray-100 pt-8 dark:border-gray-700">
            <h3 className="text-sm font-semibold text-gray-500 mb-4 uppercase tracking-wider dark:text-gray-400">{t('public.attachments')}</h3>
            <AttachmentList attachments={note.attachments} onDelete={async () => { }} readOnly />
          </div>
        )}
      </div>
      <div className="text-center mt-8 text-gray-400 text-sm dark:text-gray-500 flex items-center justify-center gap-2">
        <span className="text-xs">{t('common.poweredBy')}</span>
        <div className="flex items-center gap-1.5 opacity-80 hover:opacity-100 transition-opacity">
          <img src="/favicon.png" alt={t('common.logoAlt')} className="h-5 w-5 object-contain" />
          <span className="text-sm font-bold text-gray-500 dark:text-gray-400">{t('common.notiq')}</span>
        </div>
      </div>
    </div>
  );
}
