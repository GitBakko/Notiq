import { Editor } from '@tiptap/react';
import BubbleMenu from './BubbleMenu';
import {
  Trash2,
  Grid,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpToLine,
  ArrowDownToLine,
  Split,
  Merge,
  Eraser,
  Palette,
  Table,
  PanelTop
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { useState, useMemo, useCallback } from 'react';

interface TableBubbleMenuProps {
  editor: Editor | null;
}

export default function TableBubbleMenu({ editor }: TableBubbleMenuProps) {
  const { t } = useTranslation();
  const [showBorderMenu, setShowBorderMenu] = useState(false);
  const [showColorMenu, setShowColorMenu] = useState(false);

  const tippyOptions = useMemo(() => ({
    duration: 100,
    placement: 'top' as const,
    interactive: true,
  }), []);

  const shouldShow = useCallback(({ editor }: { editor: Editor }) => {
    return editor.isActive('table');
  }, []);

  if (!editor) {
    return null;
  }

  const setBorderStyle = (style: string) => {
    editor.chain().focus().setCellAttribute('borderStyle', style).run();
    setShowBorderMenu(false);
  };

  const setBorderColor = (color: string) => {
    editor.chain().focus().setCellAttribute('borderColor', color).run();
    setShowColorMenu(false);
  };

  const selectTable = () => {
    const { state } = editor;
    const { $from } = state.selection;
    for (let d = $from.depth; d > 0; d--) {
      const node = $from.node(d);
      if (node.type.name === 'table') {
        editor.chain().setNodeSelection($from.before(d)).run();
        return;
      }
    }
  };

  const colors = [
    { name: 'Gray', value: '#e5e7eb' },
    { name: 'Red', value: '#ef4444' },
    { name: 'Blue', value: '#3b82f6' },
    { name: 'Green', value: '#10b981' },
    { name: 'Orange', value: '#f97316' },
    { name: 'Purple', value: '#8b5cf6' },
    { name: 'Black', value: '#000000' },
  ];

  return (
    <BubbleMenu
      editor={editor}
      tippyOptions={tippyOptions}
      shouldShow={shouldShow}
      className="flex flex-wrap items-center gap-1 max-w-[420px] bg-white/90 dark:bg-gray-900/90 backdrop-blur-md shadow-xl border border-gray-200/50 dark:border-gray-700/50 rounded-xl p-1.5 animate-in fade-in zoom-in-95 duration-200"
    >
      {/* Column Operations */}
      <div className="flex items-center gap-0.5 border-r border-gray-200 dark:border-gray-700 pr-1.5 mr-0.5">
        <button
          onClick={() => editor.chain().focus().addColumnBefore().run()}
          className="p-1.5 hover:bg-blue-50 dark:hover:bg-blue-900/20 text-gray-600 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg transition-colors"
          title={t('editor.addColumnBefore', 'Add Column Before')}
        >
          <ArrowLeftToLine size={16} />
        </button>
        <button
          onClick={() => editor.chain().focus().addColumnAfter().run()}
          className="p-1.5 hover:bg-blue-50 dark:hover:bg-blue-900/20 text-gray-600 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg transition-colors"
          title={t('editor.addColumnAfter', 'Add Column After')}
        >
          <ArrowRightToLine size={16} />
        </button>
        <button
          onClick={() => editor.chain().focus().deleteColumn().run()}
          className="p-1.5 hover:bg-red-50 dark:hover:bg-red-900/20 text-gray-600 dark:text-gray-300 hover:text-red-500 rounded-lg transition-colors"
          title={t('editor.deleteColumn', 'Delete Column')}
        >
          <Eraser size={16} className="rotate-90" />
        </button>
      </div>

      {/* Row Operations */}
      <div className="flex items-center gap-0.5 border-r border-gray-200 dark:border-gray-700 pr-1.5 mr-0.5">
        <button
          onClick={() => editor.chain().focus().addRowBefore().run()}
          className="p-1.5 hover:bg-blue-50 dark:hover:bg-blue-900/20 text-gray-600 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg transition-colors"
          title={t('editor.addRowBefore', 'Add Row Before')}
        >
          <ArrowUpToLine size={16} />
        </button>
        <button
          onClick={() => editor.chain().focus().addRowAfter().run()}
          className="p-1.5 hover:bg-blue-50 dark:hover:bg-blue-900/20 text-gray-600 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg transition-colors"
          title={t('editor.addRowAfter', 'Add Row After')}
        >
          <ArrowDownToLine size={16} />
        </button>
        <button
          onClick={() => editor.chain().focus().toggleHeaderRow().run()}
          className="p-1.5 hover:bg-blue-50 dark:hover:bg-blue-900/20 text-gray-600 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg transition-colors"
          title={t('editor.toggleHeaderRow', 'Toggle Header Row')}
        >
          <PanelTop size={16} />
        </button>
        <button
          onClick={() => editor.chain().focus().deleteRow().run()}
          className="p-1.5 hover:bg-red-50 dark:hover:bg-red-900/20 text-gray-600 dark:text-gray-300 hover:text-red-500 rounded-lg transition-colors"
          title={t('editor.deleteRow', 'Delete Row')}
        >
          <Eraser size={16} />
        </button>
      </div>

      {/* Merge & Split */}
      <div className="flex items-center gap-0.5 border-r border-gray-200 dark:border-gray-700 pr-1.5 mr-0.5">
        <button
          onClick={() => editor.chain().focus().mergeCells().run()}
          disabled={!editor.can().mergeCells()}
          className="p-1.5 hover:bg-purple-50 dark:hover:bg-purple-900/20 text-gray-600 dark:text-gray-300 hover:text-purple-600 dark:hover:text-purple-400 rounded-lg transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
          title={t('editor.mergeCells', 'Merge Cells')}
        >
          <Merge size={16} />
        </button>
        <button
          onClick={() => editor.chain().focus().splitCell().run()}
          disabled={!editor.can().splitCell()}
          className="p-1.5 hover:bg-purple-50 dark:hover:bg-purple-900/20 text-gray-600 dark:text-gray-300 hover:text-purple-600 dark:hover:text-purple-400 rounded-lg transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
          title={t('editor.splitCell', 'Split Cell')}
        >
          <Split size={16} />
        </button>
      </div>

      {/* Styles & Delete */}
      <div className="flex items-center gap-0.5">
        {/* Select Table */}
        <button
          onClick={selectTable}
          className="p-1.5 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg text-gray-600 dark:text-gray-300 transition-colors"
          title={t('editor.selectTable', 'Select Table')}
        >
          <Table size={16} />
        </button>

        {/* Border Style */}
        <div className="relative">
          <button
            onClick={() => {
              setShowBorderMenu(!showBorderMenu);
              setShowColorMenu(false);
            }}
            className={clsx(
              "p-1.5 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg text-gray-600 dark:text-gray-300 transition-colors",
              showBorderMenu && "bg-gray-100 dark:bg-gray-800 text-blue-600 dark:text-blue-400"
            )}
            title={t('editor.borderStyle', 'Border Style')}
          >
            <Grid size={16} />
          </button>

          {showBorderMenu && (
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 bg-white dark:bg-gray-900 shadow-xl border border-gray-200 dark:border-gray-700 rounded-lg p-1.5 flex flex-col gap-1 min-w-[120px] animate-in fade-in slide-in-from-bottom-2 duration-200 z-50">
              <button onClick={() => setBorderStyle('solid')} className="px-3 py-1.5 text-xs hover:bg-gray-50 dark:hover:bg-gray-800 text-left rounded-md transition-colors">{t('styles.solid')}</button>
              <button onClick={() => setBorderStyle('dashed')} className="px-3 py-1.5 text-xs hover:bg-gray-50 dark:hover:bg-gray-800 text-left rounded-md border-dashed border-b border-gray-300 dark:border-gray-600 transition-colors">{t('styles.dashed')}</button>
              <button onClick={() => setBorderStyle('dotted')} className="px-3 py-1.5 text-xs hover:bg-gray-50 dark:hover:bg-gray-800 text-left rounded-md border-dotted border-b border-gray-300 dark:border-gray-600 transition-colors">{t('styles.dotted')}</button>
              <button onClick={() => setBorderStyle('none')} className="px-3 py-1.5 text-xs hover:bg-gray-50 dark:hover:bg-gray-800 text-left rounded-md text-gray-400 transition-colors">{t('styles.noBorder')}</button>
            </div>
          )}
        </div>

        {/* Border Color */}
        <div className="relative">
          <button
            onClick={() => {
              setShowColorMenu(!showColorMenu);
              setShowBorderMenu(false);
            }}
            className={clsx(
              "p-1.5 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg text-gray-600 dark:text-gray-300 transition-colors",
              showColorMenu && "bg-gray-100 dark:bg-gray-800 text-blue-600 dark:text-blue-400"
            )}
            title={t('editor.borderColor', 'Border Color')}
          >
            <Palette size={16} />
          </button>

          {showColorMenu && (
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 bg-white dark:bg-gray-900 shadow-xl border border-gray-200 dark:border-gray-700 rounded-lg p-1.5 grid grid-cols-4 gap-1 min-w-[140px] animate-in fade-in slide-in-from-bottom-2 duration-200 z-50">
              {colors.map((color) => (
                <button
                  key={color.value}
                  onClick={() => setBorderColor(color.value)}
                  className="w-6 h-6 rounded-full border border-gray-200 dark:border-gray-700 hover:scale-110 transition-transform"
                  style={{ backgroundColor: color.value }}
                  title={color.name}
                />
              ))}
            </div>
          )}
        </div>

        <div className="w-px h-4 bg-gray-200 dark:bg-gray-700 mx-1" />

        <button
          onClick={() => editor.chain().focus().deleteTable().run()}
          className="p-1.5 hover:bg-red-50 dark:hover:bg-red-900/20 text-red-500 hover:text-red-600 rounded-lg transition-colors"
          title={t('editor.deleteTable', 'Delete Table')}
        >
          <Trash2 size={16} />
        </button>
      </div>
    </BubbleMenu>
  );
}
