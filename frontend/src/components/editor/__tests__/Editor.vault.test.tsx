import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('../EditorToolbar', () => ({
  default: (props: { isVault?: boolean }) => <div data-testid="toolbar" data-vault={String(!!props.isVault)} />,
}));
vi.mock('../EditorStatusBar', () => ({ default: () => null }));
vi.mock('../TableContextMenu', () => ({ default: () => null }));
vi.mock('../TransformToKanbanModal', () => ({ default: () => <div data-testid="kanban-modal" /> }));
vi.mock('../TransformToTaskListModal', () => ({ default: () => <div data-testid="tasklist-modal" /> }));
vi.mock('../../../features/attachments/attachmentService', () => ({ uploadAttachment: vi.fn() }));

import Editor from '../Editor';

const CONTENT = '<ul><li><p>item</p></li></ul>';

async function renderEditor(isVault: boolean, scrollable: boolean) {
  const { container } = render(
    <Editor content={CONTENT} onChange={vi.fn()} isVault={isVault} scrollable={scrollable} />,
  );
  const pm = await waitFor(() => {
    const el = container.querySelector('.ProseMirror');
    if (!el) throw new Error('editor not ready');
    return el;
  });
  return pm;
}

afterEach(cleanup);

describe.each([true, false])('Editor transforms (scrollable=%s)', (scrollable) => {
  it('opens the kanban and task list modals with Ctrl+Shift+K/L in a normal note', async () => {
    await renderEditor(false, scrollable);
    fireEvent.keyDown(document, { key: 'K', ctrlKey: true, shiftKey: true });
    expect(await screen.findByTestId('kanban-modal')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'L', ctrlKey: true, shiftKey: true });
    expect(await screen.findByTestId('tasklist-modal')).toBeTruthy();
  });

  it('ignores Ctrl+Shift+K/L in the vault', async () => {
    await renderEditor(true, scrollable);
    fireEvent.keyDown(document, { key: 'K', ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(document, { key: 'L', ctrlKey: true, shiftKey: true });
    expect(screen.queryByTestId('kanban-modal')).toBeNull();
    expect(screen.queryByTestId('tasklist-modal')).toBeNull();
  });

  it('passes isVault to the toolbar', async () => {
    await renderEditor(true, scrollable);
    expect((await screen.findByTestId('toolbar')).getAttribute('data-vault')).toBe('true');
    cleanup();
    await renderEditor(false, scrollable);
    expect((await screen.findByTestId('toolbar')).getAttribute('data-vault')).toBe('false');
  });

  it('shows the transform items in the context menu of a normal note', async () => {
    const pm = await renderEditor(false, scrollable);
    fireEvent.contextMenu(pm);
    expect(await screen.findByText('editor.transform.toKanban')).toBeTruthy();
    expect(screen.getByText('editor.transform.toTaskList')).toBeTruthy();
  });

  it('keeps the context menu in the vault but without the transform items', async () => {
    const pm = await renderEditor(true, scrollable);
    fireEvent.contextMenu(pm);
    expect(await screen.findByText('editor.cut')).toBeTruthy();
    expect(screen.getByText('editor.copy')).toBeTruthy();
    expect(screen.queryByText('editor.transform.toKanban')).toBeNull();
    expect(screen.queryByText('editor.transform.toTaskList')).toBeNull();
  });
});
