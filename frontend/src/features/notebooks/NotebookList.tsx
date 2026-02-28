import { useState } from 'react';
import { timeAgo } from '../../utils/format';
import { Book, Edit2, Trash2 } from 'lucide-react';
import type { Notebook } from './notebookService';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { useTranslation } from 'react-i18next';
import { it, enUS } from 'date-fns/locale';

interface NotebookListProps {
  notebooks: Notebook[];
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}

export default function NotebookList({ notebooks, onRename, onDelete }: NotebookListProps) {
  const { t, i18n } = useTranslation();
  const dateLocale = i18n.language === 'it' ? it : enUS;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const startEditing = (notebook: Notebook) => {
    setEditingId(notebook.id);
    setEditName(notebook.name);
  };

  const handleRename = () => {
    if (editingId && editName.trim()) {
      onRename(editingId, editName.trim());
      setEditingId(null);
    }
  };

  if (!notebooks || notebooks.length === 0) {
    return <div className="p-8 text-center text-neutral-500">{t('notebooks.noNotebooks')}</div>;
  }

  return (
    <>
      <ConfirmDialog
        isOpen={!!deletingId}
        onClose={() => setDeletingId(null)}
        onConfirm={() => {
            if (deletingId) onDelete(deletingId);
        }}
        title={t('notebooks.deleteTitle')}
        message={t('notebooks.deleteConfirm')}
        confirmText={t('common.delete')}
        variant="danger"
      />
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 p-4">
        {notebooks.map((notebook) => (
          <div key={notebook.id} className="bg-white border border-neutral-200/60 rounded-lg p-4 hover:shadow-md transition-shadow group relative">
            <div className="flex items-start justify-between mb-2">
              <div className="flex items-center gap-2 text-emerald-600">
                <Book size={20} />
              </div>
              <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                 <button 
                  onClick={() => startEditing(notebook)}
                  className="p-1 text-neutral-400 hover:text-emerald-600 rounded"
                  title={t('common.rename')}
                 >
                   <Edit2 size={16} />
                 </button>
                 <button 
                  onClick={() => setDeletingId(notebook.id)}
                  className="p-1 text-neutral-400 hover:text-red-600 rounded"
                  title={t('common.delete')}
                 >
                   <Trash2 size={16} />
                 </button>
              </div>
            </div>

            {editingId === notebook.id ? (
            <div className="flex gap-2">
                <input 
                    type="text" 
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="flex-1 border border-emerald-500 rounded px-2 py-1 text-sm focus:outline-none"
                    autoFocus
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') handleRename();
                        if (e.key === 'Escape') setEditingId(null);
                    }}
                />
                <button onClick={handleRename} className="text-xs bg-emerald-600 text-white px-2 rounded">{t('common.save')}</button>
            </div>
          ) : (
            <h3 className="font-semibold text-neutral-800 truncate" title={notebook.name}>{notebook.name}</h3>
          )}
          
          <div className="mt-4 flex justify-between items-end text-xs text-neutral-500">
            <span>{t('common.updated')} {timeAgo(notebook.updatedAt, dateLocale)}</span>
            {/* <span>{notebook._count?.notes || 0} notes</span> */}
          </div>
        </div>
      ))}
      </div>
    </>
  );
}