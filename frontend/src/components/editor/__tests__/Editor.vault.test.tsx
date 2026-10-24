import { describe, it, expect, vi, afterEach } from 'vitest';
import toast from 'react-hot-toast';
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

// F.13: una nota vault non carica ne' inserisce risorse remote (web beacon) e blocca drop/paste di file senza navigare.
describe('Editor vault: niente risorse remote, niente file', () => {
  const html = '<p>testo</p><p><img src="https://evil.example/pixel.png"></p>';
  const pasteHtml = (pm: Element) => fireEvent.paste(pm, {
    clipboardData: { types: ['text/html'], getData: (t: string) => (t === 'text/html' ? html : ''), items: [], files: [] },
  });
  const file = new File(['x'], 'a.png', { type: 'image/png' });

  it('paste di HTML con <img> remoto: niente img, il testo resta, avviso', async () => {
    const err = vi.spyOn(toast, 'error').mockReturnValue('id');
    const pm = await renderEditor(true, true);
    pasteHtml(pm);
    await waitFor(() => expect(pm.textContent).toContain('testo'));
    expect(pm.querySelector('img')).toBeNull();
    expect(err.mock.calls.map((c) => (c[1] as { id: string }).id)).toContain('vault.remoteImagesRemoved');
    err.mockRestore();
  });

  it('paste di un file immagine: bloccato (preventDefault) con avviso', async () => {
    const err = vi.spyOn(toast, 'error').mockReturnValue('id');
    const pm = await renderEditor(true, true);
    const notPrevented = fireEvent.paste(pm, {
      clipboardData: { types: ['Files'], getData: () => '', items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }], files: [file] },
    });
    expect(notPrevented).toBe(false);
    expect(err.mock.calls.map((c) => (c[1] as { id: string }).id)).toContain('vault.imagesBlocked');
    err.mockRestore();
  });

  it('paste di un file insieme a testo/HTML (es. Excel): prosegue, nessun avviso imagesBlocked', async () => {
    const err = vi.spyOn(toast, 'error').mockReturnValue('id');
    const pm = await renderEditor(true, true);
    fireEvent.paste(pm, {
      clipboardData: { types: ['text/plain', 'Files'], getData: (t: string) => (t === 'text/plain' ? 'a' : ''), items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }], files: [file] },
    });
    expect(err.mock.calls.map((c) => (c[1] as { id: string }).id)).not.toContain('vault.imagesBlocked');
    err.mockRestore();
  });

  it('drop di un file a sola lettura (pagina pubblica): bloccato ma senza avviso del Vault', async () => {
    const err = vi.spyOn(toast, 'error').mockReturnValue('id');
    const { container } = render(<Editor content={CONTENT} onChange={vi.fn()} editable={false} />);
    const pm = await waitFor(() => {
      const el = container.querySelector('.ProseMirror');
      if (!el) throw new Error('editor not ready');
      return el;
    });
    const notPrevented = fireEvent.drop(pm, { dataTransfer: { types: ['Files'], files: [file], getData: () => '' } });
    expect(notPrevented).toBe(false);
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it('drop di un file: bloccato (niente navigazione) con avviso', async () => {
    const err = vi.spyOn(toast, 'error').mockReturnValue('id');
    const pm = await renderEditor(true, true);
    const notPrevented = fireEvent.drop(pm, { dataTransfer: { types: ['Files'], files: [file], getData: () => '' } });
    expect(notPrevented).toBe(false);
    expect(err.mock.calls.map((c) => (c[1] as { id: string }).id)).toContain('vault.imagesBlocked');
    err.mockRestore();
  });

  it('controllo: in una nota normale (noteId) l immagine remota incollata viene inserita', async () => {
    const { container } = render(<Editor content={CONTENT} onChange={vi.fn()} noteId="n1" />);
    const pm = await waitFor(() => {
      const el = container.querySelector('.ProseMirror');
      if (!el) throw new Error('editor not ready');
      return el;
    });
    pasteHtml(pm);
    await waitFor(() => expect(pm.querySelector('img')).not.toBeNull());
  });
});

// P-A1: editor.setEditable(editable, false) non emette 'update': niente onChange (e quindi niente salvataggio) senza una modifica vera.
describe('Editor: setEditable non emette onChange', () => {
  const pmOf = (container: HTMLElement) => waitFor(() => {
    const el = container.querySelector('.ProseMirror');
    if (!el) throw new Error('editor not ready');
    return el;
  });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('onChange non viene chiamato dopo il mount ne dopo editable false -> true', async () => {
    const onChange = vi.fn();
    const { container, rerender } = render(<Editor content={CONTENT} onChange={onChange} isVault />);
    await pmOf(container);
    await wait(50);
    expect(onChange).not.toHaveBeenCalled();
    rerender(<Editor content={CONTENT} onChange={onChange} isVault editable={false} />);
    await wait(50);
    rerender(<Editor content={CONTENT} onChange={onChange} isVault editable />);
    await wait(50);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('nota normale (noteId + uploadFn di ImageDrop): onChange non viene chiamato dopo il mount ne dopo editable false -> true', async () => {
    const onChange = vi.fn();
    const { container, rerender } = render(<Editor content={CONTENT} onChange={onChange} noteId="n1" />);
    await pmOf(container);
    await wait(50);
    expect(onChange).not.toHaveBeenCalled();
    rerender(<Editor content={CONTENT} onChange={onChange} noteId="n1" editable={false} />);
    await wait(50);
    rerender(<Editor content={CONTENT} onChange={onChange} noteId="n1" editable />);
    await wait(50);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('nota vault nuova con il contenuto vuoto di VaultPage (EMPTY_DOC): dopo SAVE_DEBOUNCE_MS nessun onChange, quindi nessun salvataggio', async () => {
    const EMPTY_DOC = '{"type":"doc","content":[{"type":"paragraph"}]}'; // come VaultPage.createVaultItem
    const onChange = vi.fn();
    const { container, rerender } = render(<Editor content={EMPTY_DOC} onChange={onChange} isVault editable={false} />);
    await pmOf(container);
    rerender(<Editor content={EMPTY_DOC} onChange={onChange} isVault editable />); // la fase passa da loading a ready
    await wait(1100); // SAVE_DEBOUNCE_MS di VaultNoteEditor = 1000
    expect(onChange).not.toHaveBeenCalled();
  });
});
