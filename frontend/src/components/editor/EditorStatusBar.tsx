import { useTranslation } from 'react-i18next';
import { Lock, Book } from 'lucide-react';

interface EditorStatusBarProps {
  characters: number;
  lines: number;
  cursorLine: number;
  cursorColumn: number;
  notebookName?: string;
  isVault?: boolean;
}

export default function EditorStatusBar({
  characters,
  lines,
  cursorLine,
  cursorColumn,
  notebookName,
  isVault,
}: EditorStatusBarProps) {
  const { t } = useTranslation();

  return (
    <div className="border-t border-neutral-200/60 dark:border-neutral-700/40 px-4 py-1 bg-neutral-50 dark:bg-neutral-800/50 flex items-center justify-between text-[11px] font-mono text-neutral-500 dark:text-neutral-400 select-none shrink-0">
      <div className="flex items-center gap-3">
        {isVault && (
          <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
            <Lock size={11} />
            {t('editor.vault')}
          </span>
        )}
        {notebookName && (
          <span className="flex items-center gap-1">
            <Book size={11} />
            <span className="max-w-[120px] truncate">{notebookName}</span>
          </span>
        )}
        <span>{characters.toLocaleString()} {t('editor.characters')}</span>
        <span>{lines.toLocaleString()} {t('editor.lines')}</span>
      </div>
      <div>
        {t('editor.line')} {cursorLine}, {t('editor.column')} {cursorColumn}
      </div>
    </div>
  );
}
