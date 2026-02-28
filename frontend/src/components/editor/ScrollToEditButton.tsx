import { useEffect, useState, useCallback, useRef } from 'react';
import { Editor } from '@tiptap/core';
import { remoteEditTrackerKey, type RemoteEditInfo } from './extensions/RemoteEditTracker';
import { ArrowDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface ScrollToEditButtonProps {
  editor: Editor;
  collaborators: Array<{ name: string; color: string; clientId: number }>;
}

export default function ScrollToEditButton({ editor, collaborators }: ScrollToEditButtonProps) {
  const { t } = useTranslation();
  const [remoteEdit, setRemoteEdit] = useState<RemoteEditInfo | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    function handleTransaction(): void {
      const state = editor.state;
      const editInfo = remoteEditTrackerKey.getState(state) as RemoteEditInfo | null;
      if (!editInfo || editInfo === remoteEdit) return;

      setRemoteEdit(editInfo);

      // Check if position is visible in viewport
      try {
        const coords = editor.view.coordsAtPos(editInfo.pos);
        const editorDom = editor.view.dom.closest('.overflow-auto') || editor.view.dom.parentElement;
        if (editorDom) {
          const rect = editorDom.getBoundingClientRect();
          const isInView = coords.top >= rect.top && coords.top <= rect.bottom;
          setIsVisible(!isInView);
        }
      } catch {
        setIsVisible(false);
      }

      // Auto-hide after 10 seconds
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = setTimeout(() => setIsVisible(false), 10000);
    }

    editor.on('transaction', handleTransaction);
    return () => {
      editor.off('transaction', handleTransaction);
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    };
  }, [editor, remoteEdit]);

  const scrollToEdit = useCallback(() => {
    if (!remoteEdit) return;
    try {
      const pos = Math.min(remoteEdit.pos, editor.state.doc.content.size - 1);
      editor.commands.setTextSelection(pos);
      editor.commands.scrollIntoView();
      setIsVisible(false);
    } catch (e) {
      console.warn('Failed to scroll to edit', e);
    }
  }, [editor, remoteEdit]);

  if (!isVisible || collaborators.length <= 1) return null;

  // Get the first non-self collaborator's color
  const collabColor = collaborators.length > 0 ? collaborators[0].color : '#10b981';

  return (
    <button
      onClick={scrollToEdit}
      className="absolute bottom-4 right-4 z-20 flex items-center gap-2 px-3 py-2 rounded-full shadow-lg
        bg-white dark:bg-neutral-800 border border-neutral-200/60 dark:border-neutral-700/40
        hover:bg-neutral-50 dark:hover:bg-neutral-700 transition-all animate-bounce-subtle
        text-sm text-neutral-700 dark:text-neutral-200"
      title={t('collaboration.jumpToEdit')}
    >
      <span
        className="w-3 h-3 rounded-full flex-shrink-0"
        style={{ backgroundColor: collabColor }}
      />
      <ArrowDown size={14} />
      <span className="hidden sm:inline">{t('collaboration.jumpToEdit')}</span>
    </button>
  );
}
