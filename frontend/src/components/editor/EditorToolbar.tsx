import { Editor } from '@tiptap/react';
import { useState, useEffect } from 'react';
import { HocuspocusProvider } from '@hocuspocus/provider';
import clsx from 'clsx';
import 'regenerator-runtime/runtime';
import SpeechRecognition, { useSpeechRecognition } from 'react-speech-recognition';
import { useAuthStore } from '../../store/authStore';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useVisualViewport } from '../../hooks/useVisualViewport';

import EditorToolbarPrimary from './toolbar/EditorToolbarPrimary';
import EditorToolbarSecondary from './toolbar/EditorToolbarSecondary';
import EditorLinkInput from './toolbar/EditorLinkInput';

interface EditorToolbarProps {
  editor: Editor | null;
  onVoiceMemo?: () => void;
  provider?: HocuspocusProvider | null;
}

export default function EditorToolbar({ editor, onVoiceMemo, provider }: EditorToolbarProps) {
  const { user } = useAuthStore();
  const isMobile = useIsMobile();
  const { isKeyboardOpen, keyboardHeight } = useVisualViewport();
  const [users, setUsers] = useState<{ user?: { name?: string; color?: string; avatarUrl?: string | null } }[]>([]);

  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

  const [isToolbarExpanded, setIsToolbarExpanded] = useState(false);
  const [showLinkInput, setShowLinkInput] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
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
          .filter(([clientId, state]: [number, Record<string, unknown>]) =>
            clientId !== currentClientId &&
            state.user &&
            (state.user as { name?: string }).name
          )
          .map(([, state]) => state as { user?: { name?: string; color?: string; avatarUrl?: string | null } });

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

  const handleOpenLinkInput = () => {
    setLinkUrl(editor.getAttributes('link').href || '');
    setShowLinkInput(true);
  };

  const handleCloseLinkInput = () => {
    setShowLinkInput(false);
    setLinkUrl('');
  };

  return (
    <div
      className={clsx(
        "border-b border-neutral-200/60 bg-white dark:bg-neutral-900 dark:border-neutral-800/40 z-10 relative flex-shrink-0",
        isMobile && isKeyboardOpen
          ? "fixed left-0 right-0 shadow-lg"
          : "sticky top-0"
      )}
      style={isMobile && isKeyboardOpen ? { bottom: `${keyboardHeight}px` } : undefined}
    >
      {/* Online Users — always visible */}
      {users.length > 0 && (
        <div className="flex -space-x-2 px-2 pt-2 border-b border-neutral-100 dark:border-neutral-800 pb-2">
          {users.map((u, i) => {
            const initial = u.user?.name?.[0]?.toUpperCase() || '?';
            const avatarUrl = u.user?.avatarUrl;
            return (
              <div
                key={i}
                className="w-8 h-8 rounded-full border-2 border-white dark:border-neutral-800 flex items-center justify-center text-xs font-bold text-white shadow-sm overflow-hidden relative"
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

      {/* Primary toolbar row */}
      <EditorToolbarPrimary
        editor={editor}
        isMobile={isMobile}
        isToolbarExpanded={isToolbarExpanded}
        setIsToolbarExpanded={setIsToolbarExpanded}
        onOpenLinkInput={handleOpenLinkInput}
      />

      {/* Inline link URL input popover */}
      {showLinkInput && (
        <EditorLinkInput
          editor={editor}
          linkUrl={linkUrl}
          setLinkUrl={setLinkUrl}
          onClose={handleCloseLinkInput}
        />
      )}

      {/* Expanded panel (mobile) / Secondary row (desktop) */}
      {(!isMobile || isToolbarExpanded) && (
        <EditorToolbarSecondary
          editor={editor}
          isMobile={isMobile}
          isDark={isDark}
          userId={user?.id}
          showEmojiPicker={showEmojiPicker}
          setShowEmojiPicker={setShowEmojiPicker}
          showTableSelector={showTableSelector}
          setShowTableSelector={setShowTableSelector}
          showKeyboardShortcuts={showKeyboardShortcuts}
          setShowKeyboardShortcuts={setShowKeyboardShortcuts}
          onOpenLinkInput={handleOpenLinkInput}
          onVoiceMemo={onVoiceMemo}
          listening={listening}
          toggleListening={toggleListening}
          browserSupportsSpeechRecognition={browserSupportsSpeechRecognition}
        />
      )}
    </div>
  );
}
