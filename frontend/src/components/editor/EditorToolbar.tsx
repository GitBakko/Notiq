import { Editor } from '@tiptap/react';
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Code,
  Smile,


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
  Type,
  ChevronDown,
  ALargeSmall,
  Mic,
  MicOff,
  AudioLines,
  Lock,
  ArrowUpDown
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { useState, useRef, useEffect } from 'react';
import { HocuspocusProvider } from '@hocuspocus/provider';
import TableSelector from './TableSelector';
import 'regenerator-runtime/runtime';
import SpeechRecognition, { useSpeechRecognition } from 'react-speech-recognition';
import { useAuthStore } from '../../store/authStore';
import EmojiPicker, { Theme } from 'emoji-picker-react';

interface EditorToolbarProps {
  editor: Editor | null;
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
      "p-2 sm:p-1.5 rounded transition-colors flex items-center justify-center min-w-[36px] min-h-[36px]",
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

export default function EditorToolbar({ editor, onVoiceMemo, provider }: EditorToolbarProps) {
  const { t } = useTranslation();
  const { user } = useAuthStore();
  const [users, setUsers] = useState<any[]>([]);

  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');


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
        const currentClientId = currentProvider.awareness.clientID;

        const activeUsers = Array.from(states.entries())
          .filter(([clientId, state]: [number, any]) =>
            clientId !== currentClientId &&
            state.user &&
            state.user.name
          )
          .map(([_, state]) => state);

        setUsers(activeUsers);
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
    <div className="flex gap-1 p-2 border-b border-gray-200 bg-white flex-wrap sm:flex-nowrap overflow-visible sticky top-0 z-10 dark:bg-gray-900 dark:border-gray-800 items-center">
      {/* Online Users */}
      {users.length > 0 && (
        <div className="flex -space-x-2 mr-4 border-r pr-4 border-gray-200 dark:border-gray-700">
          {users.map((u, i) => {
            const initial = u.user?.name?.[0]?.toUpperCase() || '?';
            const avatarUrl = u.user?.avatarUrl;
            return (
              <div
                key={i}
                className="w-8 h-8 rounded-full border-2 border-white dark:border-gray-800 flex items-center justify-center text-xs font-bold text-white shadow-sm overflow-hidden relative"
                style={{ backgroundColor: u.user?.color || '#ccc' }}
                title={u.user?.name || 'User'}
              >
                {avatarUrl ? (
                  <>
                    <img src={avatarUrl} alt="" className="w-full h-full object-cover absolute inset-0" />
                    <span className="relative z-10 text-[10px] font-bold text-white" style={{ textShadow: '0 0 3px rgba(0,0,0,0.9), 0 0 6px rgba(0,0,0,0.5)' }}>{initial}</span>
                  </>
                ) : initial}
              </div>
            );
          })}
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
        onClick={() => editor.chain().focus().insertContent({ type: 'encryptedBlock', attrs: { createdBy: user?.id } }).run()}
        title={t('editor.insertEncryptedBlock')}
      >
        <Lock size={18} />
      </ToolbarButton>

      {/* Emoji Picker */}
      <div className="relative">
        <ToolbarButton
          onClick={() => setShowEmojiPicker(!showEmojiPicker)}
          title={t('editor.insertEmoji')}
          isActive={showEmojiPicker}
        >
          <Smile size={18} />
        </ToolbarButton>
        {showEmojiPicker && (
          <div className="absolute top-full left-0 mt-2 z-50">
            <div className="fixed inset-0 z-40" onClick={() => setShowEmojiPicker(false)}></div>
            <div className="relative z-50">
              <EmojiPicker
                onEmojiClick={(data) => {
                  editor.chain().focus().insertContent(data.emoji).run();
                  // Keep open for multiple? Or close. Let's close.
                  // setShowEmojiPicker(false);
                }}
                theme={isDark ? Theme.DARK : Theme.LIGHT}
                width={300}
                height={400}
              />
            </div>
          </div>
        )}
      </div>

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

      {/* Line Height Dropdown */}
      <ToolbarDropdown
        options={[
          { label: '1.0', value: '1.0' },
          { label: '1.15', value: '1.15' },
          { label: '1.5', value: '1.5' },
          { label: '2.0', value: '2.0' },
          { label: '2.5', value: '2.5' },
          { label: '3.0', value: '3.0' },
        ]}
        value={editor.getAttributes('paragraph').lineHeight || editor.getAttributes('heading').lineHeight || '1.5'}
        onChange={(value) => editor.chain().focus().setLineHeight(value).run()}
        placeholder={t('editor.lineHeight')}
        title={t('editor.lineHeight')}
        icon={<ArrowUpDown size={14} />}
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
        onClick={() => (editor.chain().focus() as any).toggleUnderline().run()}
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
            (editor.chain().focus().extendMarkRange('link') as any).unsetLink().run();
            return;
          }
          (editor.chain().focus().extendMarkRange('link') as any).setLink({ href: url }).run();
        }}
        isActive={editor.isActive('link')}
        title={t('editor.link')}
      >
        <LinkIcon size={18} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => (editor.chain().focus() as any).unsetLink().run()}
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
        <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1 hidden group-hover:block bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 w-max p-2">
          <TableSelector
            onSelect={(rows, cols) => {
              editor.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run();
            }}
          />
        </div>
      </div>



      <div className="w-px bg-gray-200 mx-2 dark:bg-gray-700" />

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
