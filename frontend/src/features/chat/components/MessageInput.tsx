import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Smile, SendHorizontal, X, Paperclip, File } from 'lucide-react';
import EmojiPicker from './EmojiPicker';

interface MessageInputProps {
  conversationId: string;
  replyTo: { id: string; content: string; senderName: string } | null;
  onCancelReply: () => void;
  onSend: (content: string, replyToId?: string) => void;
  onSendFile?: (file: File, message: string, replyToId?: string) => void;
  onTyping: () => void;
  disabled?: boolean;
}

export default function MessageInput({
  conversationId,
  replyTo,
  onCancelReply,
  onSend,
  onSendFile,
  onTyping,
  disabled = false,
}: MessageInputProps) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [showEmoji, setShowEmoji] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-grow textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 144) + 'px'; // max ~6 lines
    }
  }, [text]);

  // Auto-focus on mount and conversation change
  useEffect(() => {
    if (!disabled) {
      textareaRef.current?.focus();
    }
  }, [conversationId, disabled]);

  // Focus when reply is set
  useEffect(() => {
    if (replyTo && !disabled) {
      textareaRef.current?.focus();
    }
  }, [replyTo, disabled]);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (selectedFile && onSendFile) {
      onSendFile(selectedFile, trimmed, replyTo?.id);
      setSelectedFile(null);
      setText('');
      onCancelReply();
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
      return;
    }
    if (!trimmed) return;
    onSend(trimmed, replyTo?.id);
    setText('');
    onCancelReply();
    // Reset height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [text, selectedFile, replyTo, onSend, onSendFile, onCancelReply]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    onTyping();
  }, [onTyping]);

  const handleEmojiSelect = useCallback((emoji: string) => {
    setText(prev => prev + emoji);
    setShowEmoji(false);
    textareaRef.current?.focus();
  }, []);

  const canSend = (text.trim().length > 0 || selectedFile !== null) && !disabled;

  return (
    <div className="border-t border-neutral-200/60 dark:border-neutral-800/40 bg-white dark:bg-neutral-950 shrink-0 safe-area-bottom">
      {/* Reply preview bar */}
      {replyTo && (
        <div className="flex items-center gap-2 px-3 pt-2 pb-1">
          <div className="flex-1 min-w-0 px-3 py-1.5 rounded-lg bg-neutral-100 dark:bg-neutral-800 border-l-2 border-emerald-500">
            <p className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 truncate">
              {replyTo.senderName}
            </p>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 truncate">
              {replyTo.content}
            </p>
          </div>
          <button
            onClick={onCancelReply}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full hover:bg-neutral-100 dark:hover:bg-neutral-800 active:bg-neutral-200 dark:active:bg-neutral-700 transition-colors"
            aria-label={t('common.close')}
          >
            <X size={18} className="text-neutral-400 dark:text-neutral-500" />
          </button>
        </div>
      )}

      {/* File preview strip */}
      {selectedFile && (
        <div className="flex items-center gap-2 px-4 py-2 bg-neutral-50 dark:bg-neutral-800/50 border-b border-neutral-200/60 dark:border-neutral-700/40">
          <File size={16} className="text-emerald-500 flex-shrink-0" />
          <span className="text-xs text-neutral-700 dark:text-neutral-300 truncate flex-1">{selectedFile.name}</span>
          <span className="text-[11px] text-neutral-400 flex-shrink-0">{(selectedFile.size / 1024).toFixed(0)} KB</span>
          <button
            onClick={() => setSelectedFile(null)}
            className="p-1 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors"
            aria-label={t('common.remove')}
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Main input row */}
      <div className="flex items-end gap-1.5 p-3">
        {/* Emoji button */}
        <div className="relative">
          <button
            onClick={() => setShowEmoji(prev => !prev)}
            disabled={disabled}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full hover:bg-neutral-100 dark:hover:bg-neutral-800 active:bg-neutral-200 dark:active:bg-neutral-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label={t('chat.addEmoji')}
          >
            <Smile size={22} className="text-neutral-500 dark:text-neutral-400" />
          </button>
          {showEmoji && (
            <EmojiPicker
              onSelect={handleEmojiSelect}
              onClose={() => setShowEmoji(false)}
            />
          )}
        </div>

        {/* Attach file button */}
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full hover:bg-neutral-100 dark:hover:bg-neutral-800 active:bg-neutral-200 dark:active:bg-neutral-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          aria-label={t('chat.attachFile')}
        >
          <Paperclip size={22} className="text-neutral-500 dark:text-neutral-400" />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) setSelectedFile(file);
            e.target.value = '';
          }}
        />

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={disabled ? t('chat.offlineMessage') : t('chat.typeMessage')}
          rows={1}
          className="flex-1 resize-none px-4 py-2.5 rounded-2xl bg-neutral-100 dark:bg-neutral-800 text-sm border-0 focus:ring-2 focus:ring-emerald-500/40 dark:text-white placeholder:text-neutral-400 dark:placeholder:text-neutral-500 disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ maxHeight: 144 }}
        />

        {/* Send button */}
        <button
          onClick={handleSend}
          disabled={!canSend}
          className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full bg-emerald-600 dark:bg-emerald-700 text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed hover:bg-emerald-700 dark:hover:bg-emerald-600 active:scale-95"
          aria-label={t('chat.send')}
        >
          <SendHorizontal size={20} />
        </button>
      </div>
    </div>
  );
}
