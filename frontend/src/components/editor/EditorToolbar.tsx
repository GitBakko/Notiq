import { Editor } from '@tiptap/react';
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Code,
  Heading1,
  Heading2,
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignJustify,
  List,
  ListOrdered,
  Quote,
  Undo,
  Redo,
  Link as LinkIcon,
  Unlink,
  Table as TableIcon,
  Columns,
  Rows,
  Trash2,
  Paperclip,
  Type,
  ChevronDown,
  ALargeSmall,
  Mic,
  MicOff,
  AudioLines,
  Lock
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { useState, useRef, useEffect } from 'react';
import { HocuspocusProvider } from '@hocuspocus/provider';
import TableSelector from './TableSelector';
import 'regenerator-runtime/runtime';
import SpeechRecognition, { useSpeechRecognition } from 'react-speech-recognition';

interface EditorToolbarProps {
  editor: Editor | null;
  onAttach?: () => void;
  onVoiceMemo?: () => void;
  provider?: HocuspocusProvider | null;
}

interface ToolbarButtonProps {
  onClick: () => void;
  isActive?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
  title: string;
}

const ToolbarButton = ({
  onClick,
  isActive = false,
  disabled = false,
  children,
  title
}: ToolbarButtonProps) => (
  <button
    onClick={onClick}
    disabled={disabled}
    title={title}
    className={clsx(
      "p-2 rounded transition-colors flex items-center justify-center",
      isActive
        ? "bg-gray-200 text-gray-900 dark:bg-gray-700 dark:text-white"
        : "bg-transparent text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200",
      disabled && "opacity-50 cursor-not-allowed hover:bg-transparent hover:text-gray-500 dark:hover:bg-transparent dark:hover:text-gray-400"
    )}
  >
    {children}
  </button>
);

// Font size options (using inline styles)
const FONT_SIZES = [
  { label: 'Small', value: '12px' },
  { label: 'Normal', value: '16px' },
  { label: 'Large', value: '20px' },
  { label: 'XL', value: '24px' },
  { label: 'XXL', value: '32px' },
];

interface DropdownProps {
  options: { label: string; value: string }[];
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  title: string;
  icon?: React.ReactNode;
}

const ToolbarDropdown = ({ options, value, onChange, placeholder, title, icon }: DropdownProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const selectedLabel = options.find(o => o.value === value)?.label || placeholder;

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        title={title}
        className="flex items-center gap-1 px-2 py-1.5 rounded text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800 transition-colors min-w-[80px]"
      >
        {icon || <Type size={14} />}
        <span className="truncate">{selectedLabel}</span>
        <ChevronDown size={12} className={clsx("transition-transform", isOpen && "rotate-180")} />
      </button>
      {isOpen && (
        <div className="absolute top-full left-0 mt-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 min-w-[140px]">
          {options.map((option) => (
            <button
              key={option.value}
              onClick={() => {
                onChange(option.value);
                setIsOpen(false);
              }}
              className={clsx(
                "w-full text-left px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-800 first:rounded-t-lg last:rounded-b-lg transition-colors",
                option.value === value
                  ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400"
                  : "text-gray-700 dark:text-gray-300"
              )}
              style={option.value ? { fontFamily: option.value } : undefined}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default function EditorToolbar({ editor, onAttach, onVoiceMemo, provider }: EditorToolbarProps) {
  const { t } = useTranslation();
  const [users, setUsers] = useState<any[]>([]);

  const {
    transcript,
    listening,
    resetTranscript,
    browserSupportsSpeechRecognition
  } = useSpeechRecognition();

  useEffect(() => {
    if (transcript && editor) {
      // Insert text at current selection
      editor.chain().focus().insertContent(transcript).run();
      // Reset transcript to avoid re-inserting the same text
      resetTranscript();
    }
  }, [transcript, editor, resetTranscript]);

  const toggleListening = () => {
    if (listening) {
      SpeechRecognition.stopListening();
    } else {
      SpeechRecognition.startListening({ continuous: true });
    }
  };

  useEffect(() => {
    const currentProvider = provider;
    if (!currentProvider) {
      setUsers([]);
      return;
    }

    const updateUsers = () => {
      if (currentProvider && currentProvider.awareness) {
        const states = currentProvider.awareness.getStates();
        setUsers(Array.from(states.values()));
      }
    };

    if (currentProvider && currentProvider.awareness) {
      currentProvider.awareness.on('change', updateUsers);
      updateUsers();
    }

    return () => {
      if (currentProvider && currentProvider.awareness) {
        currentProvider.awareness.off('change', updateUsers);
      }
    };
  }, [provider]);

  if (!editor) {
    return null;
  }

  // Font family options
  const fontFamilies = [
    { label: t('editor.fontDefault'), value: '' },
    { label: 'Arial', value: 'Arial' },
    { label: 'Times New Roman', value: 'Times New Roman' },
    { label: 'Courier New', value: 'Courier New' },
    { label: 'Georgia', value: 'Georgia' },
    { label: 'Verdana', value: 'Verdana' },
  ];

  const currentFontFamily = editor.getAttributes('textStyle').fontFamily || '';
  const currentFontSize = editor.getAttributes('textStyle').fontSize || '';

  return (
    <div className="flex gap-1 p-2 border-b border-gray-200 bg-white flex-wrap sticky top-0 z-10 dark:bg-gray-900 dark:border-gray-800 items-center">
      {/* Online Users */}
      {users.length > 0 && (
        <div className="flex -space-x-2 mr-4 border-r pr-4 border-gray-200 dark:border-gray-700">
          {users.map((u, i) => (
            <div
              key={i}
              className="w-8 h-8 rounded-full border-2 border-white dark:border-gray-800 bg-gray-200 flex items-center justify-center text-xs font-bold text-white shadow-sm"
              style={{ backgroundColor: u.user?.color || '#ccc' }}
              title={u.user?.name || 'User'}
            >
              {u.user?.name?.[0]?.toUpperCase() || '?'}
            </div>
          ))}
        </div>
      )}

      {/* Speech to Text */}
      {browserSupportsSpeechRecognition && (
        <>
          <ToolbarButton
            onClick={toggleListening}
            isActive={listening}
            title={listening ? t('editor.stopDictation') : t('editor.startDictation')}
          >
            {listening ? <MicOff size={18} className="text-red-500" /> : <Mic size={18} />}
          </ToolbarButton>
        </>
      )}

      {/* Voice Memo */}
      {onVoiceMemo && (
        <ToolbarButton
          onClick={onVoiceMemo}
          title={t('editor.voiceMemo')}
        >
          <AudioLines size={18} />
        </ToolbarButton>
      )}

      <ToolbarButton
        onClick={() => editor.chain().focus().insertContent('<encrypted-block></encrypted-block>').run()}
        title={t('editor.insertEncryptedBlock')}
      >
        <Lock size={18} />
      </ToolbarButton>

      <div className="w-px bg-gray-200 mx-1 dark:bg-gray-700" />

      {/* Font Family Dropdown */}
      <ToolbarDropdown
        options={fontFamilies}
        value={currentFontFamily}
        onChange={(value) => {
          if (value) {
            editor.chain().focus().setFontFamily(value).run();
          } else {
            editor.chain().focus().unsetFontFamily().run();
          }
        }}
        placeholder={t('editor.fontFamily')}
        title={t('editor.fontFamily')}
        icon={<Type size={14} />}
      />

      {/* Font Size Dropdown */}
      <ToolbarDropdown
        options={FONT_SIZES}
        value={currentFontSize}
        onChange={(value) => {
          if (value) {
            editor.chain().focus().setFontSize(value).run();
          } else {
            editor.chain().focus().unsetFontSize().run();
          }
        }}
        placeholder={t('editor.fontSize')}
        title={t('editor.fontSize')}
        icon={<ALargeSmall size={14} />}
      />

      <div className="w-px bg-gray-200 mx-1 dark:bg-gray-700" />

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
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        isActive={editor.isActive('underline')}
        title={t('editor.underline')}
      >
        <Underline size={18} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleStrike().run()}
        isActive={editor.isActive('strike')}
        title={t('editor.strikethrough')}
      >
        <Strikethrough size={18} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleCode().run()}
        isActive={editor.isActive('code')}
        title={t('editor.code')}
      >
        <Code size={18} />
      </ToolbarButton>

      <div className="w-px bg-gray-200 mx-2 dark:bg-gray-700" />

      <ToolbarButton
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        isActive={editor.isActive('heading', { level: 1 })}
        title={t('editor.heading1')}
      >
        <Heading1 size={18} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        isActive={editor.isActive('heading', { level: 2 })}
        title={t('editor.heading2')}
      >
        <Heading2 size={18} />
      </ToolbarButton>

      <div className="w-px bg-gray-200 mx-2 dark:bg-gray-700" />

      <ToolbarButton
        onClick={() => editor.chain().focus().setTextAlign('left').run()}
        isActive={editor.isActive({ textAlign: 'left' })}
        title={t('editor.alignLeft')}
      >
        <AlignLeft size={18} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().setTextAlign('center').run()}
        isActive={editor.isActive({ textAlign: 'center' })}
        title={t('editor.alignCenter')}
      >
        <AlignCenter size={18} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().setTextAlign('right').run()}
        isActive={editor.isActive({ textAlign: 'right' })}
        title={t('editor.alignRight')}
      >
        <AlignRight size={18} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().setTextAlign('justify').run()}
        isActive={editor.isActive({ textAlign: 'justify' })}
        title={t('editor.alignJustify')}
      >
        <AlignJustify size={18} />
      </ToolbarButton>

      <div className="w-px bg-gray-200 mx-2 dark:bg-gray-700" />

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
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        isActive={editor.isActive('blockquote')}
        title={t('editor.blockquote')}
      >
        <Quote size={18} />
      </ToolbarButton>

      <div className="w-px bg-gray-200 mx-2 dark:bg-gray-700" />

      <ToolbarButton
        onClick={() => {
          const previousUrl = editor.getAttributes('link').href;
          const url = window.prompt('URL', previousUrl);
          if (url === null) return;
          if (url === '') {
            editor.chain().focus().extendMarkRange('link').unsetLink().run();
            return;
          }
          editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
        }}
        isActive={editor.isActive('link')}
        title={t('editor.link')}
      >
        <LinkIcon size={18} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().unsetLink().run()}
        disabled={!editor.isActive('link')}
        title={t('editor.unlink')}
      >
        <Unlink size={18} />
      </ToolbarButton>

      <div className="w-px bg-gray-200 mx-2 dark:bg-gray-700" />

      <div className="relative group">
        <ToolbarButton
          onClick={() => { }} // No-op, handled by hover/dropdown
          title={t('editor.insertTable')}
        >
          <TableIcon size={18} />
        </ToolbarButton>
        <div className="absolute top-full left-0 mt-1 hidden group-hover:block bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50">
          <TableSelector
            onSelect={(rows, cols) => {
              editor.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run();
            }}
          />
        </div>
      </div>

      {editor.isActive('table') && (
        <>
          <ToolbarButton
            onClick={() => editor.chain().focus().addColumnBefore().run()}
            title={t('editor.addColumnBefore')}
          >
            <Columns size={18} className="rotate-90" />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => editor.chain().focus().addColumnAfter().run()}
            title={t('editor.addColumnAfter')}
          >
            <Columns size={18} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => editor.chain().focus().addRowBefore().run()}
            title={t('editor.addRowBefore')}
          >
            <Rows size={18} className="rotate-90" />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => editor.chain().focus().addRowAfter().run()}
            title={t('editor.addRowAfter')}
          >
            <Rows size={18} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => editor.chain().focus().deleteTable().run()}
            title={t('editor.deleteTable')}
          >
            <Trash2 size={18} />
          </ToolbarButton>
        </>
      )}

      <div className="w-px bg-gray-200 mx-2 dark:bg-gray-700" />

      {onAttach && (
        <ToolbarButton
          onClick={onAttach}
          title={t('editor.attach')}
        >
          <Paperclip size={18} />
        </ToolbarButton>
      )}

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
    </div>
  );
}
