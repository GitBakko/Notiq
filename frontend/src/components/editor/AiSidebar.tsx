import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  X, Send, Sparkles, FileText, Tags, Wand2,
  ArrowRight, Trash2, Square, Loader2, AlertCircle, Plus,
} from 'lucide-react';
import { useAiChat, type AiMessage } from '../../hooks/useAiChat';
import type { Editor } from '@tiptap/react';

interface AiSidebarProps {
  noteId: string;
  editor: Editor | null;
  onClose: () => void;
}

export default function AiSidebar({ noteId, editor, onClose }: AiSidebarProps) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [selectedOp, setSelectedOp] = useState<string>('ask');
  const [targetLang, setTargetLang] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const {
    messages, isStreaming, isLoadingHistory, error,
    sendMessage, clearHistory, stopStreaming,
  } = useAiChat(noteId);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = () => {
    const msg = input.trim();
    if (!msg && selectedOp === 'ask') return;

    // For quick operations, use note content as the message if no custom input
    const finalMsg = msg || getDefaultMessage(selectedOp);
    if (!finalMsg) return;

    sendMessage(finalMsg, selectedOp, targetLang || undefined);
    setInput('');
  };

  const handleQuickAction = (op: string) => {
    const msg = getDefaultMessage(op);
    if (msg) {
      sendMessage(msg, op);
    }
  };

  const getDefaultMessage = (op: string): string => {
    switch (op) {
      case 'summarize': return t('ai.summarizePrompt');
      case 'continue': return t('ai.continuePrompt');
      case 'tags': return t('ai.tagsPrompt');
      default: return '';
    }
  };

  const handleInsert = (text: string) => {
    if (!editor) return;
    editor.chain().focus().insertContent(text).run();
  };

  const handleReplace = (text: string) => {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    if (from === to) {
      // No selection: insert at cursor
      editor.chain().focus().insertContent(text).run();
    } else {
      editor.chain().focus().deleteSelection().insertContent(text).run();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const parseTags = (content: string): string[] => {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) return parsed.filter(t => typeof t === 'string');
    } catch {
      // Try to extract array from text
      const match = content.match(/\[.*?\]/s);
      if (match) {
        try {
          return JSON.parse(match[0]).filter((t: unknown) => typeof t === 'string');
        } catch { /* ignore */ }
      }
    }
    return [];
  };

  return (
    <div className="w-[350px] h-full border-l border-neutral-200/60 dark:border-neutral-700/40 bg-white dark:bg-neutral-900 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-200/60 dark:border-neutral-700/40">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-emerald-500" />
          <span className="font-medium text-sm text-neutral-900 dark:text-neutral-100">{t('ai.title')}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={clearHistory}
            title={t('ai.clearHistory')}
            className="p-1.5 rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Quick actions */}
      <div className="flex gap-1.5 px-3 py-2 border-b border-neutral-100 dark:border-neutral-800 overflow-x-auto">
        <QuickButton icon={<FileText className="h-3 w-3" />} label={t('ai.summarize')} onClick={() => handleQuickAction('summarize')} disabled={isStreaming} />
        <QuickButton icon={<Tags className="h-3 w-3" />} label={t('ai.suggestTags')} onClick={() => handleQuickAction('tags')} disabled={isStreaming} />
        <QuickButton icon={<ArrowRight className="h-3 w-3" />} label={t('ai.continue')} onClick={() => handleQuickAction('continue')} disabled={isStreaming} />
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
        {isLoadingHistory && (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-4 w-4 animate-spin text-neutral-400" />
          </div>
        )}

        {!isLoadingHistory && messages.length === 0 && (
          <div className="text-center py-8 text-sm text-neutral-400 dark:text-neutral-500">
            <Sparkles className="h-8 w-8 mx-auto mb-2 opacity-30" />
            <p>{t('ai.emptyState')}</p>
          </div>
        )}

        {messages.map((msg, i) => (
          <MessageBubble
            key={i}
            message={msg}
            onInsert={handleInsert}
            onReplace={handleReplace}
            parseTags={parseTags}
            t={t}
          />
        ))}

        {error && (
          <div className="flex items-center gap-2 text-xs text-red-500 px-2 py-1">
            <AlertCircle className="h-3 w-3" />
            <span>{error}</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="border-t border-neutral-200/60 dark:border-neutral-700/40 px-3 py-2">
        {/* Operation selector */}
        <div className="flex gap-1 mb-2">
          {(['ask', 'improve', 'translate'] as const).map(op => (
            <button
              key={op}
              onClick={() => setSelectedOp(op)}
              className={`text-xs px-2 py-1 rounded-md transition-colors ${
                selectedOp === op
                  ? 'bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300'
                  : 'text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800'
              }`}
            >
              {t(`ai.op_${op}`)}
            </button>
          ))}
        </div>

        {selectedOp === 'translate' && (
          <input
            type="text"
            placeholder={t('ai.targetLanguage')}
            value={targetLang}
            onChange={e => setTargetLang(e.target.value)}
            className="w-full mb-2 px-2 py-1 text-xs rounded-md border border-neutral-200 dark:border-neutral-700 bg-transparent text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400"
          />
        )}

        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('ai.inputPlaceholder')}
            rows={2}
            className="flex-1 resize-none rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          />
          {isStreaming ? (
            <button
              onClick={stopStreaming}
              className="p-2 rounded-lg bg-red-500 text-white hover:bg-red-600"
            >
              <Square className="h-4 w-4" />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim() && selectedOp === 'ask'}
              className="p-2 rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Send className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Sub-components ---

function QuickButton({ icon, label, onClick, disabled }: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-1 px-2 py-1 text-xs rounded-md border border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50 whitespace-nowrap"
    >
      {icon}
      {label}
    </button>
  );
}

function MessageBubble({ message, onInsert, onReplace, parseTags, t }: {
  message: AiMessage;
  onInsert: (text: string) => void;
  onReplace: (text: string) => void;
  parseTags: (content: string) => string[];
  t: (key: string) => string;
}) {
  const isUser = message.role === 'user';

  // Special rendering for tag suggestions
  const tags = !isUser && message.operation === 'tags' && !message.isStreaming
    ? parseTags(message.content)
    : [];

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[90%] rounded-lg px-3 py-2 text-sm ${
        isUser
          ? 'bg-emerald-500 text-white'
          : 'bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100'
      }`}>
        {/* Message content */}
        <div className="whitespace-pre-wrap break-words">
          {message.content}
          {message.isStreaming && <span className="inline-block w-1.5 h-4 bg-emerald-500 animate-pulse ml-0.5" />}
        </div>

        {/* Tag suggestions */}
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {tags.map((tag, i) => (
              <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300">
                {tag}
                <Plus className="h-2.5 w-2.5 cursor-pointer hover:text-emerald-900" />
              </span>
            ))}
          </div>
        )}

        {/* Insert/Replace actions for assistant messages */}
        {!isUser && !message.isStreaming && message.content && message.operation !== 'tags' && (
          <div className="flex gap-2 mt-2 pt-2 border-t border-neutral-200 dark:border-neutral-700">
            <button
              onClick={() => onInsert(message.content)}
              className="text-xs text-emerald-600 dark:text-emerald-400 hover:underline flex items-center gap-1"
            >
              <Wand2 className="h-3 w-3" />
              {t('ai.insertIntoNote')}
            </button>
            <button
              onClick={() => onReplace(message.content)}
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1"
            >
              <ArrowRight className="h-3 w-3" />
              {t('ai.replaceSelection')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
