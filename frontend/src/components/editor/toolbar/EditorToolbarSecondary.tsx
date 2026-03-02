import { Editor } from '@tiptap/react';
import {
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
  Link as LinkIcon,
  Unlink,
  Table as TableIcon,
  Type,
  ALargeSmall,
  Mic,
  MicOff,
  AudioLines,
  Lock,
  ArrowUpDown,
  Keyboard
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import ToolbarButton from './ToolbarButton';
import ToolbarDropdown, { type DropdownOption } from './ToolbarDropdown';
import TableSelector from '../TableSelector';
import EmojiPicker, { Theme } from 'emoji-picker-react';

// Font size options (using inline styles)
const FONT_SIZES: DropdownOption[] = [
  { label: 'Small', value: '12px' },
  { label: 'Normal', value: '16px' },
  { label: 'Large', value: '20px' },
  { label: 'XL', value: '24px' },
  { label: 'XXL', value: '32px' },
];

const LINE_HEIGHTS: DropdownOption[] = [
  { label: '1.0', value: '1.0' },
  { label: '1.15', value: '1.15' },
  { label: '1.5', value: '1.5' },
  { label: '2.0', value: '2.0' },
  { label: '2.5', value: '2.5' },
  { label: '3.0', value: '3.0' },
];

interface EditorToolbarSecondaryProps {
  editor: Editor;
  isMobile: boolean;
  isDark: boolean;
  userId?: string;
  showEmojiPicker: boolean;
  setShowEmojiPicker: (show: boolean) => void;
  showTableSelector: boolean;
  setShowTableSelector: (show: boolean) => void;
  showKeyboardShortcuts: boolean;
  setShowKeyboardShortcuts: (show: boolean) => void;
  onOpenLinkInput: () => void;
  onVoiceMemo?: () => void;
  listening: boolean;
  toggleListening: () => void;
  browserSupportsSpeechRecognition: boolean;
}

export default function EditorToolbarSecondary({
  editor,
  isMobile,
  isDark,
  userId,
  showEmojiPicker,
  setShowEmojiPicker,
  showTableSelector,
  setShowTableSelector,
  showKeyboardShortcuts,
  setShowKeyboardShortcuts,
  onOpenLinkInput,
  onVoiceMemo,
  listening,
  toggleListening,
  browserSupportsSpeechRecognition
}: EditorToolbarSecondaryProps) {
  const { t } = useTranslation();

  // Font family options
  const fontFamilies: DropdownOption[] = [
    { label: t('editor.fontDefault'), value: '' },
    { label: 'Arial', value: 'Arial' },
    { label: 'Times New Roman', value: 'Times New Roman' },
    { label: 'Courier New', value: 'Courier New' },
    { label: 'Georgia', value: 'Georgia' },
    { label: 'Verdana', value: 'Verdana' },
  ];

  const currentFontFamily = editor.getAttributes('textStyle').fontFamily || '';
  const currentFontSize = editor.getAttributes('textStyle').fontSize || '';

  const Separator = () => <div className="w-px bg-neutral-200 mx-1 dark:bg-neutral-700" />;

  return (
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
              "absolute top-full mt-1 bg-white dark:bg-neutral-900 border border-neutral-200/60 dark:border-neutral-700/40 rounded-lg shadow-lg z-50 w-max p-2",
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
        onClick={() => editor.chain().focus().insertContent({ type: 'encryptedBlock', attrs: { createdBy: userId } }).run()}
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
        options={LINE_HEIGHTS}
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
                <div className="absolute top-full right-0 mt-1 bg-white dark:bg-neutral-900 border border-neutral-200/60 dark:border-neutral-700/40 rounded-lg shadow-lg z-50 p-3 w-64">
                  <p className="text-xs font-semibold text-neutral-700 dark:text-neutral-200 mb-2">{t('editor.shortcuts.title')}</p>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-neutral-600 dark:text-neutral-400">{t('editor.pasteAsPlainText')}</span>
                      <kbd className="px-1.5 py-0.5 bg-neutral-100 dark:bg-neutral-800 rounded text-neutral-500 dark:text-neutral-400 font-mono text-[10px]">Ctrl+Shift+V</kbd>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-neutral-600 dark:text-neutral-400">{t('editor.transform.toKanban')}</span>
                      <kbd className="px-1.5 py-0.5 bg-neutral-100 dark:bg-neutral-800 rounded text-neutral-500 dark:text-neutral-400 font-mono text-[10px]">Ctrl+Shift+K</kbd>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-neutral-600 dark:text-neutral-400">{t('editor.transform.toTaskList')}</span>
                      <kbd className="px-1.5 py-0.5 bg-neutral-100 dark:bg-neutral-800 rounded text-neutral-500 dark:text-neutral-400 font-mono text-[10px]">Ctrl+Shift+L</kbd>
                    </div>
                  </div>
                  <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-2 italic">{t('editor.shortcuts.transformHint')}</p>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
