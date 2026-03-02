import { Editor } from '@tiptap/react';
import {
  Bold,
  Italic,
  Underline,
  List,
  ListOrdered,
  Link as LinkIcon,
  Unlink,
  Undo,
  Redo,
  MoreVertical
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import ToolbarButton from './ToolbarButton';

interface EditorToolbarPrimaryProps {
  editor: Editor;
  isMobile: boolean;
  isToolbarExpanded: boolean;
  setIsToolbarExpanded: (expanded: boolean) => void;
  onOpenLinkInput: () => void;
}

export default function EditorToolbarPrimary({
  editor,
  isMobile,
  isToolbarExpanded,
  setIsToolbarExpanded,
  onOpenLinkInput
}: EditorToolbarPrimaryProps) {
  const { t } = useTranslation();

  const Separator = () => <div className="w-px bg-neutral-200 mx-1 dark:bg-neutral-700" />;

  return (
    <div className={clsx(
      "flex gap-1 p-2 items-center",
      isMobile ? "flex-nowrap" : "flex-wrap overflow-visible"
    )}>
      {/* Bold, Italic, Underline — always visible */}
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBold().run()}
        isActive={editor.isActive('bold')}
        title={t('editor.bold')}
      >
        <Bold size={18} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleItalic().run()}
        isActive={editor.isActive('italic')}
        title={t('editor.italic')}
      >
        <Italic size={18} />
      </ToolbarButton>
      <ToolbarButton
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onClick={() => (editor.chain().focus() as any).toggleUnderline().run()}
        isActive={editor.isActive('underline')}
        title={t('editor.underline')}
      >
        <Underline size={18} />
      </ToolbarButton>

      {/* Desktop-only: Lists, Link, Unlink inline */}
      {!isMobile && (
        <>
          <Separator />
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleBulletList().run()}
            isActive={editor.isActive('bulletList')}
            title={t('editor.bulletList')}
          >
            <List size={18} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
            isActive={editor.isActive('orderedList')}
            title={t('editor.orderedList')}
          >
            <ListOrdered size={18} />
          </ToolbarButton>

          <Separator />

          <ToolbarButton
            onClick={onOpenLinkInput}
            isActive={editor.isActive('link')}
            title={t('editor.link')}
          >
            <LinkIcon size={18} />
          </ToolbarButton>
          <ToolbarButton
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            onClick={() => (editor.chain().focus() as any).unsetLink().run()}
            disabled={!editor.isActive('link')}
            title={t('editor.unlink')}
          >
            <Unlink size={18} />
          </ToolbarButton>
        </>
      )}

      <Separator />

      {/* Undo, Redo — always visible */}
      <ToolbarButton
        onClick={() => editor.chain().focus().undo().run()}
        disabled={!editor.can().undo()}
        title={t('editor.undo')}
      >
        <Undo size={18} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().redo().run()}
        disabled={!editor.can().redo()}
        title={t('editor.redo')}
      >
        <Redo size={18} />
      </ToolbarButton>

      {/* Mobile: More toggle button — pushed to right edge */}
      {isMobile && (
        <>
          <div className="flex-1" />
          <ToolbarButton
            onClick={() => setIsToolbarExpanded(!isToolbarExpanded)}
            title={isToolbarExpanded ? t('editor.collapseToolbar') : t('editor.expandToolbar')}
            isActive={isToolbarExpanded}
          >
            <MoreVertical size={18} />
          </ToolbarButton>
        </>
      )}
    </div>
  );
}
