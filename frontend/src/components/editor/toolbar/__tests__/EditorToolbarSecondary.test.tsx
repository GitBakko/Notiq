import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { Editor } from '@tiptap/react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('emoji-picker-react', () => ({ default: () => null, Theme: { DARK: 'dark', LIGHT: 'light' } }));
vi.mock('../../TableSelector', () => ({ default: () => null }));

import EditorToolbarSecondary from '../EditorToolbarSecondary';

// Render only reads attributes/active state; commands run on click, which these tests never do.
const editorStub = {
  getAttributes: () => ({}),
  isActive: () => false,
  can: () => ({}),
} as unknown as Editor;

function renderSecondary(isVault?: boolean) {
  return render(
    <EditorToolbarSecondary
      editor={editorStub}
      isMobile={false}
      isDark={false}
      showEmojiPicker={false}
      setShowEmojiPicker={vi.fn()}
      showTableSelector={false}
      setShowTableSelector={vi.fn()}
      showKeyboardShortcuts={true}
      setShowKeyboardShortcuts={vi.fn()}
      onOpenLinkInput={vi.fn()}
      listening={false}
      toggleListening={vi.fn()}
      browserSupportsSpeechRecognition={false}
      isVault={isVault}
    />,
  );
}

afterEach(cleanup);

describe('EditorToolbarSecondary keyboard shortcuts panel', () => {
  it('lists the Kanban and Task list shortcuts for a normal note', () => {
    renderSecondary();
    expect(screen.getByText('editor.transform.toKanban')).toBeTruthy();
    expect(screen.getByText('editor.transform.toTaskList')).toBeTruthy();
    expect(screen.getByText('Ctrl+Shift+K')).toBeTruthy();
    expect(screen.getByText('Ctrl+Shift+L')).toBeTruthy();
    expect(screen.getByText('editor.shortcuts.transformHint')).toBeTruthy();
  });

  it('hides the Kanban and Task list shortcuts in the vault, keeps paste as plain text', () => {
    renderSecondary(true);
    expect(screen.queryByText('editor.transform.toKanban')).toBeNull();
    expect(screen.queryByText('editor.transform.toTaskList')).toBeNull();
    expect(screen.queryByText('Ctrl+Shift+K')).toBeNull();
    expect(screen.queryByText('Ctrl+Shift+L')).toBeNull();
    expect(screen.queryByText('editor.shortcuts.transformHint')).toBeNull();
    expect(screen.getByText('Ctrl+Shift+V')).toBeTruthy();
  });
});
