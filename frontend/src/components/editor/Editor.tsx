import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TextAlign from '@tiptap/extension-text-align';
import { Table } from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import Link from '@tiptap/extension-link';
import TextStyle from '@tiptap/extension-text-style';
import FontFamily from '@tiptap/extension-font-family';
import { useEffect, useRef } from 'react';
import EditorToolbar from './EditorToolbar';

interface EditorProps {
  content: string;
  onChange: (content: string) => void;
  editable?: boolean;
  onAttach?: () => void;
}

// Define extensions outside to prevent re-creation on render
const extensions = [
  StarterKit,
  TextAlign.configure({
    types: ['heading', 'paragraph'],
  }),
  Table.configure({
    resizable: true,
  }),
  TableRow,
  TableHeader,
  TableCell,
  Link.configure({
    openOnClick: false,
    autolink: true,
  }),
  TextStyle,
  FontFamily,
];

export default function Editor({ content, onChange, editable = true, onAttach }: EditorProps) {
  const isUpdating = useRef(false);

  const editor = useEditor({
    extensions,
    content, // Only used for initial content due to empty dependency array
    editable,
    onUpdate: ({ editor }) => {
      isUpdating.current = true;
      onChange(editor.getHTML());
      // Reset the flag after a short delay to allow the parent state to settle
      setTimeout(() => {
        isUpdating.current = false;
      }, 0);
    },
    editorProps: {
      attributes: {
        class: 'prose prose-sm sm:prose lg:prose-lg xl:prose-2xl focus:outline-none min-h-[500px] px-8 py-4 dark:prose-invert max-w-none w-full',
      },
    },
  }, []); // Empty dependency array: only initialize once on mount

  // Sync editable state
  useEffect(() => {
    if (editor) {
      editor.setEditable(editable);
    }
  }, [editable, editor]);

  if (!editor) {
    return null;
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {editable && <EditorToolbar editor={editor} onAttach={onAttach} />}
      <div className="flex-1 overflow-y-auto">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
