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
  ArrowUpDown,
  Keyboard,
  MoreVertical
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
import { useIsMobile } from '../../hooks/useIsMobile';
import { useVisualViewport } from '../../hooks/useVisualViewport';

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
    aria-label={title}
    className={clsx(
      "p-2 sm:p-1.5 rounded transition-colors flex items-center justify-center min-w-[40px] min-h-[40px] md:min-w-[36px] md:min-h-[36px]",
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
  const isMobile = useIsMobile();
  const { isKeyboardOpen, keyboardHeight } = useVisualViewport();
  const [users, setUsers] = useState<any[]>([]);

  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

  const [isToolbarExpanded, setIsToolbarExpanded] = useState(false);
  const [showLinkInput, setShowLinkInput] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const linkInputRef = useRef<HTMLInputElement>(null);
  const [showTableSelector, setShowTableSelector] = useState(false);
  const [showKeyboardShortcuts, setShowKeyboardShortcuts] = useState(false);

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

  // Auto-focus link input when shown
  useEffect(() => {
    if (showLinkInput && linkInputRef.current) {
      linkInputRef.current.focus();
    }
  }, [showLinkInput]);

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

  // Separator component for readability
  const Separator = () => <div className="w-px bg-gray-200 mx-1 dark:bg-gray-700" />;

  return (
    <div
      className={clsx(
        "border-b border-gray-200 bg-white dark:bg-gray-900 dark:border-gray-800 z-10 relative flex-shrink-0",
        isMobile && isKeyboardOpen
          ? "fixed left-0 right-0 shadow-lg"
          : "sticky top-0"
      )}
      style={isMobile && isKeyboardOpen ? { bottom: `${keyboardHeight}px` } : undefined}
    >
      {/* Online Users — always visible */}
      {users.length > 0 && (
        <div className="flex -space-x-2 px-2 pt-2 border-b border-gray-100 dark:border-gray-800 pb-2">
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

      {/* ══ Primary toolbar row ══ */}
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
              onClick={() => {
                setLinkUrl(editor.getAttributes('link').href || '');
                setShowLinkInput(true);
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

      {/* Inline link URL input popover */}
      {showLinkInput && (
        <div className="absolute left-0 right-0 top-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-2 mx-2 z-20 flex items-center gap-2">
          <input
            ref={linkInputRef}
            type="url"
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (linkUrl.trim()) {
                  (editor.chain().focus().extendMarkRange('link') as any).setLink({ href: linkUrl.trim() }).run();
                } else {
                  (editor.chain().focus().extendMarkRange('link') as any).unsetLink().run();
                }
                setShowLinkInput(false);
                setLinkUrl('');
              }
              if (e.key === 'Escape') {
                setShowLinkInput(false);
                setLinkUrl('');
                editor.commands.focus();
              }
            }}
            placeholder={t('editor.linkUrl')}
            className="flex-1 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded px-2 py-1.5 text-sm text-gray-900 dark:text-white outline-none focus:border-emerald-500"
            autoFocus
          />
          <button
            onClick={() => {
              if (linkUrl.trim()) {
                (editor.chain().focus().extendMarkRange('link') as any).setLink({ href: linkUrl.trim() }).run();
              } else {
                (editor.chain().focus().extendMarkRange('link') as any).unsetLink().run();
              }
              setShowLinkInput(false);
              setLinkUrl('');
            }}
            className="px-3 py-1.5 bg-emerald-600 text-white text-sm rounded hover:bg-emerald-700 transition-colors flex-shrink-0"
          >
            {t('editor.linkConfirm')}
          </button>
          <button
            onClick={() => { setShowLinkInput(false); setLinkUrl(''); editor.commands.focus(); }}
            className="px-2 py-1.5 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 text-sm flex-shrink-0"
          >
            {t('editor.linkCancel')}
          </button>
        </div>
      )}

      {/* ══ Expanded panel (mobile) / Secondary row (desktop) ══ */}
      {(!isMobile || isToolbarExpanded) && (
        <div className={clsx(
          "flex gap-1 px-2 pb-2 items-center",
          isMobile ? "flex-wrap overflow-visible" : "flex-wrap overflow-visible"
        )}>
          {/* Mobile-only: Lists + Link/Unlink (moved from primary row) */}
          {isMobile && (
            <>
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
                onClick={() => {
                  setLinkUrl(editor.getAttributes('link').href || '');
                  setShowLinkInput(true);
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
              <Separator />
            </>
          )}

          {/* Strikethrough, Code */}
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

          <Separator />

          {/* 4x Alignment */}
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

          <Separator />

          {/* Blockquote */}
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
            isActive={editor.isActive('blockquote')}
            title={t('editor.blockquote')}
          >
            <Quote size={18} />
          </ToolbarButton>

          {/* Table */}
          <div className="relative">
            <ToolbarButton
              onClick={() => setShowTableSelector(!showTableSelector)}
              title={t('editor.insertTable')}
            >
              <TableIcon size={18} />
            </ToolbarButton>
            {showTableSelector && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowTableSelector(false)} />
                <div className={clsx(
                  "absolute top-full mt-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 w-max p-2",
                  isMobile ? "right-0" : "left-1/2 -translate-x-1/2"
                )}>
                  <TableSelector
                    onSelect={(rows, cols) => {
                      editor.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run();
                      setShowTableSelector(false);
                    }}
                  />
                </div>
              </>
            )}
          </div>

          {/* Encrypted Block */}
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
              <div className={clsx("absolute top-full mt-2 z-50", isMobile ? "right-0" : "left-0")}>
                <div className="fixed inset-0 z-40" onClick={() => setShowEmojiPicker(false)}></div>
                <div className="relative z-50">
                  <EmojiPicker
                    onEmojiClick={(data) => {
                      editor.chain().focus().insertContent(data.emoji).run();
                    }}
                    theme={isDark ? Theme.DARK : Theme.LIGHT}
                    width={isMobile ? 280 : 300}
                    height={isMobile ? 350 : 400}
                  />
                </div>
              </div>
            )}
          </div>

          <Separator />

          {/* Speech to Text */}
          {browserSupportsSpeechRecognition && (
            <ToolbarButton
              onClick={toggleListening}
              isActive={listening}
              title={listening ? t('editor.stopDictation') : t('editor.startDictation')}
            >
              {listening ? <MicOff size={18} className="text-red-500" /> : <Mic size={18} />}
            </ToolbarButton>
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

          <Separator />

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
            value={editor.getAttributes('paragraph').lineHeight || editor.getAttributes('heading').lineHeight || ''}
            onChange={(value) => editor.chain().focus().setLineHeight(value).run()}
            placeholder={t('editor.lineHeight')}
            title={t('editor.lineHeight')}
            icon={<ArrowUpDown size={14} />}
          />

          {/* Keyboard Shortcuts Info (desktop only) */}
          {!isMobile && (
            <>
              <Separator />
              <div className="relative">
                <ToolbarButton
                  onClick={() => setShowKeyboardShortcuts(!showKeyboardShortcuts)}
                  title={t('editor.shortcuts.title')}
                >
                  <Keyboard size={18} />
                </ToolbarButton>
                {showKeyboardShortcuts && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setShowKeyboardShortcuts(false)} />
                    <div className="absolute top-full right-0 mt-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 p-3 w-64">
                      <p className="text-xs font-semibold text-gray-700 dark:text-gray-200 mb-2">{t('editor.shortcuts.title')}</p>
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-gray-600 dark:text-gray-400">{t('editor.pasteAsPlainText')}</span>
                          <kbd className="px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-gray-500 dark:text-gray-400 font-mono text-[10px]">Ctrl+Shift+V</kbd>
                        </div>
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-gray-600 dark:text-gray-400">{t('editor.transform.toKanban')}</span>
                          <kbd className="px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-gray-500 dark:text-gray-400 font-mono text-[10px]">Ctrl+Shift+K</kbd>
                        </div>
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-gray-600 dark:text-gray-400">{t('editor.transform.toTaskList')}</span>
                          <kbd className="px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-gray-500 dark:text-gray-400 font-mono text-[10px]">Ctrl+Shift+L</kbd>
                        </div>
                      </div>
                      <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-2 italic">{t('editor.shortcuts.transformHint')}</p>
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
