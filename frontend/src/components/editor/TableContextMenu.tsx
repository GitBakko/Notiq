import { Editor } from '@tiptap/react';
import { createPortal } from 'react-dom';
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
  PanelTop,
  ChevronRight,
  MoveHorizontal,
  Check,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useState, useEffect, useRef, useCallback, useLayoutEffect, useMemo } from 'react';

interface TableContextMenuProps {
  editor: Editor;
  position: { x: number; y: number };
  onClose: () => void;
}

const MENU_WIDTH = 220;
const SUBMENU_WIDTH = 160;
const VIEWPORT_MARGIN = 8;

type SubmenuType = 'borderStyle' | 'borderColor' | 'tableWidth';

export default function TableContextMenu({ editor, position, onClose }: TableContextMenuProps) {
  const { t } = useTranslation();
  const [activeSubmenu, setActiveSubmenu] = useState<SubmenuType | null>(null);
  const [submenuPos, setSubmenuPos] = useState<{ top: number; left: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState({ x: position.x, y: position.y });

  // Hover tracking for smooth trigger-to-submenu transitions
  const triggerHoverRef = useRef(false);
  const submenuHoverRef = useRef(false);
  const closeTimerRef = useRef<number>(0);

  // Measure real menu height and adjust position after render
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

  // Submenu opens to the right by default, or left if no space
  const submenuOnLeft = menuPos.x + MENU_WIDTH + SUBMENU_WIDTH > window.innerWidth - VIEWPORT_MARGIN;

  // Clean up timer on unmount
  useEffect(() => {
    return () => clearTimeout(closeTimerRef.current);
  }, []);

  // Close on outside click
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        (!submenuRef.current || !submenuRef.current.contains(e.target as Node))
      ) {
        onClose();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  // Submenu hover handlers
  const openSubmenu = useCallback((type: SubmenuType, e: React.MouseEvent) => {
    clearTimeout(closeTimerRef.current);
    triggerHoverRef.current = true;
    setActiveSubmenu(type);
    const rect = e.currentTarget.getBoundingClientRect();
    setSubmenuPos({
      top: rect.top,
      left: submenuOnLeft ? rect.left - SUBMENU_WIDTH - 4 : rect.right + 4,
    });
  }, [submenuOnLeft]);

  const startCloseSubmenu = useCallback(() => {
    triggerHoverRef.current = false;
    closeTimerRef.current = window.setTimeout(() => {
      if (!submenuHoverRef.current) {
        setActiveSubmenu(null);
        setSubmenuPos(null);
      }
    }, 150);
  }, []);

  const handleSubmenuEnter = useCallback(() => {
    clearTimeout(closeTimerRef.current);
    submenuHoverRef.current = true;
  }, []);

  const handleSubmenuLeave = useCallback(() => {
    submenuHoverRef.current = false;
    closeTimerRef.current = window.setTimeout(() => {
      if (!triggerHoverRef.current) {
        setActiveSubmenu(null);
        setSubmenuPos(null);
      }
    }, 150);
  }, []);

  const runAction = useCallback((action: () => void) => {
    action();
    onClose();
  }, [onClose]);

  const setBorderStyle = useCallback((style: string) => {
    editor.chain().focus().setCellAttribute('borderStyle', style).run();
    onClose();
  }, [editor, onClose]);

  const setBorderColor = useCallback((color: string) => {
    editor.chain().focus().setCellAttribute('borderColor', color).run();
    onClose();
  }, [editor, onClose]);

  const findTablePos = useCallback(() => {
    const { state } = editor;
    const { $from } = state.selection;
    for (let d = $from.depth; d > 0; d--) {
      const node = $from.node(d);
      if (node.type.name === 'table') {
        return $from.before(d);
      }
    }
    return null;
  }, [editor]);

  const selectTable = useCallback(() => {
    const pos = findTablePos();
    if (pos !== null) {
      editor.chain().setNodeSelection(pos).run();
    }
    onClose();
  }, [editor, onClose, findTablePos]);

  const setTableWidth = useCallback((mode: 'auto' | 'free') => {
    const pos = findTablePos();
    if (pos !== null) {
      const { tr } = editor.state;
      tr.setNodeMarkup(pos, undefined, {
        ...editor.state.doc.nodeAt(pos)?.attrs,
        tableWidth: mode === 'free' ? 'free' : null,
      });
      editor.view.dispatch(tr);
    }
    onClose();
  }, [editor, onClose, findTablePos]);

  const canMerge = editor.can().mergeCells();
  const canSplit = editor.can().splitCell();

  // Read current active states for submenu indicators
  const currentState = useMemo(() => {
    const { state } = editor;
    const { $from } = state.selection;

    // Table width
    let tableWidth: string | null = null;
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type.name === 'table') {
        tableWidth = $from.node(d).attrs.tableWidth;
        break;
      }
    }

    // Cell border style & color
    let borderStyle: string | null = null;
    let borderColor: string | null = null;
    for (let d = $from.depth; d > 0; d--) {
      const node = $from.node(d);
      if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
        borderStyle = node.attrs.borderStyle || null;
        borderColor = node.attrs.borderColor || null;
        break;
      }
    }

    return { tableWidth, borderStyle, borderColor };
  }, [editor]);

  const colors = [
    { name: 'Gray', value: '#e5e7eb' },
    { name: 'Red', value: '#ef4444' },
    { name: 'Blue', value: '#3b82f6' },
    { name: 'Green', value: '#10b981' },
    { name: 'Orange', value: '#f97316' },
    { name: 'Purple', value: '#8b5cf6' },
    { name: 'Black', value: '#000000' },
  ];

  const menuItemClass = "w-full flex items-center gap-3 px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors text-left rounded-md";
  const disabledClass = "w-full flex items-center gap-3 px-3 py-2 text-sm text-gray-300 dark:text-gray-600 cursor-not-allowed text-left rounded-md";
  const dangerClass = "w-full flex items-center gap-3 px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors text-left rounded-md";
  const separatorClass = "border-t border-gray-100 dark:border-gray-800 my-1";

  const activeItemClass = "w-full flex items-center justify-between px-3 py-2 text-sm text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 transition-colors text-left rounded-md font-medium";

  // Render submenu content based on active type
  const renderSubmenuContent = () => {
    if (activeSubmenu === 'tableWidth') {
      const isAuto = currentState.tableWidth !== 'free';
      const isFree = currentState.tableWidth === 'free';
      return (
        <div className="py-1.5">
          <button className={isAuto ? activeItemClass : menuItemClass} onClick={() => setTableWidth('auto')}>
            <span>{t('editor.tableWidthAuto', 'Auto')}</span>
            {isAuto && <Check size={14} className="flex-shrink-0" />}
          </button>
          <button className={isFree ? activeItemClass : menuItemClass} onClick={() => setTableWidth('free')}>
            <span>{t('editor.tableWidthFree', 'Free')}</span>
            {isFree && <Check size={14} className="flex-shrink-0" />}
          </button>
        </div>
      );
    }
    if (activeSubmenu === 'borderStyle') {
      const styles = [
        { value: 'solid', label: t('styles.solid', 'Solid') },
        { value: 'dashed', label: t('styles.dashed', 'Dashed') },
        { value: 'dotted', label: t('styles.dotted', 'Dotted') },
        { value: 'none', label: t('styles.noBorder', 'No Border') },
      ];
      return (
        <div className="py-1.5">
          {styles.map((s) => {
            const isActive = currentState.borderStyle === s.value;
            return (
              <button
                key={s.value}
                className={isActive ? activeItemClass : menuItemClass}
                onClick={() => setBorderStyle(s.value)}
              >
                <span>{s.label}</span>
                {isActive && <Check size={14} className="flex-shrink-0" />}
              </button>
            );
          })}
        </div>
      );
    }
    if (activeSubmenu === 'borderColor') {
      return (
        <div className="p-2">
          <div className="grid grid-cols-4 gap-1.5">
            {colors.map((color) => {
              const isActive = currentState.borderColor === color.value;
              return (
                <button
                  key={color.value}
                  onClick={() => setBorderColor(color.value)}
                  className={`w-7 h-7 rounded-full border-2 hover:scale-110 transition-transform ${isActive ? 'border-emerald-500 ring-2 ring-emerald-300 dark:ring-emerald-700' : 'border-gray-200 dark:border-gray-700'}`}
                  style={{ backgroundColor: color.value }}
                  title={color.name}
                />
              );
            })}
          </div>
        </div>
      );
    }
    return null;
  };

  return createPortal(
    <>
      {/* Main menu */}
      <div
        ref={menuRef}
        className="fixed z-[9999] bg-white dark:bg-gray-900 shadow-xl border border-gray-200 dark:border-gray-700 rounded-lg py-1.5 animate-in fade-in zoom-in-95 duration-150 overflow-y-auto"
        style={{
          top: menuPos.y,
          left: menuPos.x,
          width: MENU_WIDTH,
          maxHeight: `calc(100vh - ${VIEWPORT_MARGIN * 2}px)`,
        }}
      >
        {/* Column Operations */}
        <button className={menuItemClass} onClick={() => runAction(() => editor.chain().focus().addColumnBefore().run())}>
          <ArrowLeftToLine size={16} className="text-blue-500 flex-shrink-0" />
          <span>{t('editor.addColumnBefore', 'Add Column Before')}</span>
        </button>
        <button className={menuItemClass} onClick={() => runAction(() => editor.chain().focus().addColumnAfter().run())}>
          <ArrowRightToLine size={16} className="text-blue-500 flex-shrink-0" />
          <span>{t('editor.addColumnAfter', 'Add Column After')}</span>
        </button>
        <button className={dangerClass} onClick={() => runAction(() => editor.chain().focus().deleteColumn().run())}>
          <Eraser size={16} className="rotate-90 flex-shrink-0" />
          <span>{t('editor.deleteColumn', 'Delete Column')}</span>
        </button>

        <div className={separatorClass} />

        {/* Row Operations */}
        <button className={menuItemClass} onClick={() => runAction(() => editor.chain().focus().addRowBefore().run())}>
          <ArrowUpToLine size={16} className="text-blue-500 flex-shrink-0" />
          <span>{t('editor.addRowBefore', 'Add Row Before')}</span>
        </button>
        <button className={menuItemClass} onClick={() => runAction(() => editor.chain().focus().addRowAfter().run())}>
          <ArrowDownToLine size={16} className="text-blue-500 flex-shrink-0" />
          <span>{t('editor.addRowAfter', 'Add Row After')}</span>
        </button>
        <button className={menuItemClass} onClick={() => runAction(() => editor.chain().focus().toggleHeaderRow().run())}>
          <PanelTop size={16} className="text-blue-500 flex-shrink-0" />
          <span>{t('editor.toggleHeaderRow', 'Toggle Header Row')}</span>
        </button>
        <button className={dangerClass} onClick={() => runAction(() => editor.chain().focus().deleteRow().run())}>
          <Eraser size={16} className="flex-shrink-0" />
          <span>{t('editor.deleteRow', 'Delete Row')}</span>
        </button>

        <div className={separatorClass} />

        {/* Merge & Split */}
        <button className={canMerge ? menuItemClass : disabledClass} disabled={!canMerge} onClick={() => canMerge && runAction(() => editor.chain().focus().mergeCells().run())}>
          <Merge size={16} className="text-purple-500 flex-shrink-0" />
          <span>{t('editor.mergeCells', 'Merge Cells')}</span>
        </button>
        <button className={canSplit ? menuItemClass : disabledClass} disabled={!canSplit} onClick={() => canSplit && runAction(() => editor.chain().focus().splitCell().run())}>
          <Split size={16} className="text-purple-500 flex-shrink-0" />
          <span>{t('editor.splitCell', 'Split Cell')}</span>
        </button>

        <div className={separatorClass} />

        {/* Table Operations */}
        <button className={menuItemClass} onClick={selectTable}>
          <Table size={16} className="text-gray-500 flex-shrink-0" />
          <span>{t('editor.selectTable', 'Select Table')}</span>
        </button>

        {/* Table Width trigger */}
        <div
          onMouseEnter={(e) => openSubmenu('tableWidth', e)}
          onMouseLeave={startCloseSubmenu}
        >
          <button className={`${menuItemClass} justify-between`}>
            <span className="flex items-center gap-3">
              <MoveHorizontal size={16} className="text-gray-500 flex-shrink-0" />
              <span>{t('editor.tableWidth', 'Table Width')}</span>
            </span>
            <ChevronRight size={14} className="text-gray-400" />
          </button>
        </div>

        {/* Border Style trigger */}
        <div
          onMouseEnter={(e) => openSubmenu('borderStyle', e)}
          onMouseLeave={startCloseSubmenu}
        >
          <button className={`${menuItemClass} justify-between`}>
            <span className="flex items-center gap-3">
              <Grid size={16} className="text-gray-500 flex-shrink-0" />
              <span>{t('editor.borderStyle', 'Border Style')}</span>
            </span>
            <ChevronRight size={14} className="text-gray-400" />
          </button>
        </div>

        {/* Border Color trigger */}
        <div
          onMouseEnter={(e) => openSubmenu('borderColor', e)}
          onMouseLeave={startCloseSubmenu}
        >
          <button className={`${menuItemClass} justify-between`}>
            <span className="flex items-center gap-3">
              <Palette size={16} className="text-gray-500 flex-shrink-0" />
              <span>{t('editor.borderColor', 'Border Color')}</span>
            </span>
            <ChevronRight size={14} className="text-gray-400" />
          </button>
        </div>

        <div className={separatorClass} />

        {/* Delete Table */}
        <button className={dangerClass} onClick={() => runAction(() => editor.chain().focus().deleteTable().run())}>
          <Trash2 size={16} className="flex-shrink-0" />
          <span>{t('editor.deleteTable', 'Delete Table')}</span>
        </button>
      </div>

      {/* Submenu — rendered OUTSIDE the scrollable menu as a sibling */}
      {activeSubmenu && submenuPos && (
        <div
          ref={submenuRef}
          className="fixed z-[10000] bg-white dark:bg-gray-900 shadow-xl border border-gray-200 dark:border-gray-700 rounded-lg animate-in fade-in duration-100"
          style={{
            top: submenuPos.top,
            left: submenuPos.left,
            minWidth: SUBMENU_WIDTH,
          }}
          onMouseEnter={handleSubmenuEnter}
          onMouseLeave={handleSubmenuLeave}
        >
          {renderSubmenuContent()}
        </div>
      )}
    </>,
    document.body
  );
}
