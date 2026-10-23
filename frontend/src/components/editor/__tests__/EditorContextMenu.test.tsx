import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import EditorContextMenu from '../EditorContextMenu';

function makeEditor() {
  const editor = new Editor({ extensions: [StarterKit], content: '<ul><li>a</li><li>b</li></ul>' });
  editor.commands.selectAll();
  return editor;
}

afterEach(cleanup);

describe('EditorContextMenu transforms', () => {
  it('shows both transform items and calls the callbacks when provided', () => {
    const editor = makeEditor();
    const onKanban = vi.fn();
    const onTaskList = vi.fn();
    render(
      <EditorContextMenu editor={editor} position={{ x: 0, y: 0 }} onClose={vi.fn()} onTransformToKanban={onKanban} onTransformToTaskList={onTaskList} />,
    );
    fireEvent.click(screen.getByText('editor.transform.toKanban'));
    fireEvent.click(screen.getByText('editor.transform.toTaskList'));
    expect(onKanban).toHaveBeenCalledTimes(1);
    expect(onTaskList).toHaveBeenCalledTimes(1);
  });

  it('hides the transform items but keeps cut/copy/paste when callbacks are absent (vault)', () => {
    const editor = makeEditor();
    render(<EditorContextMenu editor={editor} position={{ x: 0, y: 0 }} onClose={vi.fn()} />);
    expect(screen.queryByText('editor.transform.toKanban')).toBeNull();
    expect(screen.queryByText('editor.transform.toTaskList')).toBeNull();
    expect(screen.queryByText('editor.transform.itemsSelected')).toBeNull();
    expect(screen.getByText('editor.cut')).toBeTruthy();
    expect(screen.getByText('editor.copy')).toBeTruthy();
    expect(screen.getByText('editor.paste')).toBeTruthy();
    expect(screen.getByText('editor.pasteAsPlainText')).toBeTruthy();
  });
});
