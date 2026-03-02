import { useRef, useEffect } from 'react';
import { Editor } from '@tiptap/react';
import { useTranslation } from 'react-i18next';

interface EditorLinkInputProps {
  editor: Editor;
  linkUrl: string;
  setLinkUrl: (url: string) => void;
  onClose: () => void;
}

export default function EditorLinkInput({ editor, linkUrl, setLinkUrl, onClose }: EditorLinkInputProps) {
  const { t } = useTranslation();
  const linkInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (linkInputRef.current) {
      linkInputRef.current.focus();
    }
  }, []);

  const applyLink = () => {
    if (linkUrl.trim()) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (editor.chain().focus().extendMarkRange('link') as any).setLink({ href: linkUrl.trim() }).run();
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (editor.chain().focus().extendMarkRange('link') as any).unsetLink().run();
    }
    onClose();
  };

  const cancelLink = () => {
    onClose();
    editor.commands.focus();
  };

  return (
    <div className="absolute left-0 right-0 top-full bg-white dark:bg-neutral-800 border border-neutral-200/60 dark:border-neutral-700/40 rounded-lg shadow-lg p-2 mx-2 z-20 flex items-center gap-2">
      <input
        ref={linkInputRef}
        type="url"
        value={linkUrl}
        onChange={(e) => setLinkUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            applyLink();
          }
          if (e.key === 'Escape') {
            cancelLink();
          }
        }}
        placeholder={t('editor.linkUrl')}
        className="flex-1 bg-neutral-50 dark:bg-neutral-700 border border-neutral-200 dark:border-neutral-600 rounded px-2 py-1.5 text-sm text-neutral-900 dark:text-white outline-none focus:border-emerald-500"
        autoFocus
      />
      <button
        onClick={applyLink}
        className="px-3 py-1.5 bg-emerald-600 text-white text-sm rounded hover:bg-emerald-700 transition-colors flex-shrink-0"
      >
        {t('editor.linkConfirm')}
      </button>
      <button
        onClick={cancelLink}
        className="px-2 py-1.5 text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200 text-sm flex-shrink-0"
      >
        {t('editor.linkCancel')}
      </button>
    </div>
  );
}
