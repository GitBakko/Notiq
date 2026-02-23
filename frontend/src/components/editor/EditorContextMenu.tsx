import { Editor } from '@tiptap/react';
import { createPortal } from 'react-dom';
import { Scissors, Copy, ClipboardPaste, ClipboardType, LayoutDashboard, ListChecks } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useEffect, useRef, useLayoutEffect, useState, useMemo } from 'react';

export interface ListItemInfo {
  text: string;
  from: number;
  to: number;
}

/**
 * Walk the current selection and extract list item texts with positions.
 * Supports bulletList/orderedList listItem and taskItem nodes.
 */
export function extractListItems(editor: Editor): ListItemInfo[] {
  const { state } = editor;
  const { from, to } = state.selection;
  const items: ListItemInfo[] = [];

  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === 'listItem' || node.type.name === 'taskItem') {
      // Preserve newlines between block-level children (e.g. multiple paragraphs)
      const lines: string[] = [];
      node.forEach(child => {
        if (child.isTextblock) {
          lines.push(child.textContent);
        }
      });
      items.push({
        text: lines.join('\n').trim(),
        from: pos,
        to: pos + node.nodeSize,
      });
      return false; // Don't descend into the listItem children
    }
    return true;
  });

  return items.filter(item => item.text.length > 0);
}

interface EditorContextMenuProps {
  editor: Editor;
  position: { x: number; y: number };
  onClose: () => void;
  onTransformToKanban?: (items: ListItemInfo[]) => void;
  onTransformToTaskList?: (items: ListItemInfo[]) => void;
}

const MENU_WIDTH = 240;
const VIEWPORT_MARGIN = 8;

export default function EditorContextMenu({ editor, position, onClose, onTransformToKanban, onTransformToTaskList }: EditorContextMenuProps) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState({ x: position.x, y: position.y });

  const listItems = useMemo(() => extractListItems(editor), [editor, position]);

  // Adjust position to stay within viewport
  useLayoutEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const maxX = window.innerWidth - VIEWPORT_MARGIN;
    const maxY = window.innerHeight - VIEWPORT_MARGIN;

    let x = position.x;
    let y = position.y;

    if (x + rect.width > maxX) x = maxX - rect.width;
    x = Math.max(VIEWPORT_MARGIN, x);

    if (y + rect.height > maxY) y = maxY - rect.height;
    y = Math.max(VIEWPORT_MARGIN, y);

    setMenuPos({ x, y });
  }, [position]);

  // Close on outside click or Escape
  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  function handleCut() {
    document.execCommand('cut');
    onClose();
  }

  function handleCopy() {
    document.execCommand('copy');
    onClose();
  }

  function handlePaste() {
    navigator.clipboard.readText().then((text) => {
      if (text) {
        editor.commands.insertContent(text);
      }
    }).catch(() => {
      // Fallback: clipboard API may not be available
    });
    onClose();
  }

  function handlePasteAsPlainText() {
    navigator.clipboard.readText().then((text) => {
      if (text) {
        editor.view.dispatch(
          editor.view.state.tr.insertText(text)
        );
      }
    }).catch(() => {
      // Fallback: clipboard API may not be available
    });
    onClose();
  }

  const menuItemClass =
    'w-full flex items-center justify-between px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors text-left';
  const separatorClass = 'border-t border-gray-200 dark:border-gray-700 my-1';

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-[9999] bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl py-1 animate-in fade-in zoom-in-95 duration-150"
      style={{
        top: menuPos.y,
        left: menuPos.x,
        width: MENU_WIDTH,
      }}
    >
      <button className={menuItemClass} onClick={handleCut}>
        <span className="flex items-center gap-3">
          <Scissors size={16} className="text-gray-500 dark:text-gray-400 flex-shrink-0" />
          <span>{t('editor.cut')}</span>
        </span>
        <span className="text-xs text-gray-400 dark:text-gray-500">Ctrl+X</span>
      </button>
      <button className={menuItemClass} onClick={handleCopy}>
        <span className="flex items-center gap-3">
          <Copy size={16} className="text-gray-500 dark:text-gray-400 flex-shrink-0" />
          <span>{t('editor.copy')}</span>
        </span>
        <span className="text-xs text-gray-400 dark:text-gray-500">Ctrl+C</span>
      </button>

      <div className={separatorClass} />

      <button className={menuItemClass} onClick={handlePaste}>
        <span className="flex items-center gap-3">
          <ClipboardPaste size={16} className="text-gray-500 dark:text-gray-400 flex-shrink-0" />
          <span>{t('editor.paste')}</span>
        </span>
        <span className="text-xs text-gray-400 dark:text-gray-500">Ctrl+V</span>
      </button>
      <button className={menuItemClass} onClick={handlePasteAsPlainText}>
        <span className="flex items-center gap-3">
          <ClipboardType size={16} className="text-gray-500 dark:text-gray-400 flex-shrink-0" />
          <span>{t('editor.pasteAsPlainText')}</span>
        </span>
        <span className="text-xs text-gray-400 dark:text-gray-500">Ctrl+Shift+V</span>
      </button>

      {listItems.length > 0 && (
        <>
          <div className={separatorClass} />
          <div className="px-3 py-1">
            <span className="text-xs text-gray-400 dark:text-gray-500">
              {t('editor.transform.itemsSelected', { count: listItems.length })}
            </span>
          </div>
          <button
            className={menuItemClass}
            onClick={() => {
              onTransformToKanban?.(listItems);
              onClose();
            }}
          >
            <span className="flex items-center gap-3">
              <LayoutDashboard size={16} className="text-gray-500 dark:text-gray-400 flex-shrink-0" />
              <span>{t('editor.transform.toKanban')}</span>
            </span>
          </button>
          <button
            className={menuItemClass}
            onClick={() => {
              onTransformToTaskList?.(listItems);
              onClose();
            }}
          >
            <span className="flex items-center gap-3">
              <ListChecks size={16} className="text-gray-500 dark:text-gray-400 flex-shrink-0" />
              <span>{t('editor.transform.toTaskList')}</span>
            </span>
          </button>
        </>
      )}
    </div>,
    document.body
  );
}
