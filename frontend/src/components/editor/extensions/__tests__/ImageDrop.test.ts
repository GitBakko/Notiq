import { describe, it, expect, vi, afterEach } from 'vitest';
import toast from 'react-hot-toast';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { ImageDrop } from '../ImageDrop';

vi.mock('i18next', () => ({ default: { t: (k: string) => k } }));

const editors: Editor[] = [];
const make = (opts: { uploadFn?: boolean; editable?: boolean } = {}) => {
  const editor = new Editor({
    extensions: [
      StarterKit,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ImageDrop.configure({ uploadFn: opts.uploadFn ? vi.fn() : null } as any),
    ],
    content: '<p></p>',
    editable: opts.editable ?? true,
  });
  editors.push(editor);
  return editor;
};
const toastIds = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => (c[1] as { id: string }).id);
const images = (editor: Editor) => {
  let n = 0;
  editor.state.doc.descendants((node) => { if (node.type.name === 'image') n++; });
  return n;
};

// Digita il testo come farebbe l'utente: tutto tranne l'ultimo carattere inserito, poi l'ultimo passa per handleTextInput (input rules).
const type = (editor: Editor, text: string) => {
  const { view } = editor;
  const head = text.slice(0, -1);
  view.dispatch(view.state.tr.insertText(head, 1));
  const pos = view.state.selection.from;
  view.someProp('handleTextInput', (f) => f(view, pos, pos, text.slice(-1), () => view.state.tr));
};

afterEach(() => {
  editors.splice(0).forEach((e) => e.destroy());
  vi.restoreAllMocks();
});

describe('ImageDrop senza uploadFn (vault): niente immagini remote', () => {
  it('insertContent con <img> remoto: nessun nodo image e avviso', () => {
    const err = vi.spyOn(toast, 'error').mockReturnValue('id');
    const editor = make();
    editor.commands.insertContent('<img src="https://x/b.png">');
    expect(images(editor)).toBe(0);
    expect(toastIds(err)).toContain('vault.remoteImagesRemoved');
  });

  it('sintassi markdown digitata ![x](https://...): resta testo, nessuna immagine', () => {
    const editor = make();
    type(editor, '![x](https://evil.example/p.png)');
    expect(images(editor)).toBe(0);
    expect(editor.getText()).toContain('![x](https://evil.example/p.png');
  });

  it('src locale /uploads/ resta', () => {
    const err = vi.spyOn(toast, 'error').mockReturnValue('id');
    const editor = make();
    editor.commands.insertContent('<img src="/uploads/x.png">');
    expect(images(editor)).toBe(1);
    expect(toastIds(err)).not.toContain('vault.remoteImagesRemoved');
  });

  it('editor non modificabile (pagina pubblica): l immagine remota resta', () => {
    const err = vi.spyOn(toast, 'error').mockReturnValue('id');
    const editor = make({ editable: false });
    editor.commands.insertContent('<img src="https://x/b.png">');
    expect(images(editor)).toBe(1);
    expect(toastIds(err)).not.toContain('vault.remoteImagesRemoved');
  });
});

describe('ImageDrop con uploadFn (note normali): invariato', () => {
  it('insertContent con <img> remoto resta e nessun avviso', () => {
    const err = vi.spyOn(toast, 'error').mockReturnValue('id');
    const editor = make({ uploadFn: true });
    editor.commands.insertContent('<img src="https://x/b.png">');
    expect(images(editor)).toBe(1);
    expect(err).not.toHaveBeenCalled();
  });

  it('sintassi markdown digitata diventa un immagine', () => {
    const editor = make({ uploadFn: true });
    type(editor, '![x](https://x/p.png)');
    expect(images(editor)).toBe(1);
  });
});
