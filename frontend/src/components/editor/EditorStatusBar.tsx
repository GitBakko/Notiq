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
    <div className="border-t border-neutral-200/60 dark:border-neutral-700/40 px-4 py-1 bg-neutral-50 dark:bg-neutral-800/50 flex min-w-0 items-center justify-between gap-2 text-[11px] font-mono text-neutral-500 dark:text-neutral-400 select-none shrink-0">
      <div className="flex min-w-0 items-center gap-3">
        {isVault && (
          <span className="flex shrink-0 items-center gap-1 text-emerald-600 dark:text-emerald-400">
            <Lock size={11} />
            {t('editor.vault')}
          </span>
        )}
        {notebookName && (
          <span className="flex min-w-0 items-center gap-1">
            <Book size={11} className="shrink-0" />
            <span className="block max-w-[60px] sm:max-w-[120px] truncate">{notebookName}</span>
          </span>
        )}
        <span className="shrink-0">{characters.toLocaleString()} {t('editor.characters')}</span>
        <span className="shrink-0">{lines.toLocaleString()} {t('editor.lines')}</span>
      </div>
      <div className="shrink-0 whitespace-nowrap">
        {t('editor.line')} {cursorLine}, {t('editor.column')} {cursorColumn}
      </div>
    </div>
  );
}
