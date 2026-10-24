import Image from '@tiptap/extension-image';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { ReactNodeViewRenderer } from '@tiptap/react';
import i18n from 'i18next';
import toast from 'react-hot-toast';
import { ResizableImage } from './ResizableImage';
import { isLocalImageSrc, stripSlice } from './remoteImages';

// Senza uploadFn (vault, pagina pubblica in sola lettura) l'editor non ha dove mettere i file: drop e paste di file si bloccano
// (niente navigazione del browser verso il file) e le immagini remote incollate si tolgono (F.13: niente web beacon).
const notify = (key: string) => toast.error(i18n.t(key), { id: key });

export const ImageDrop = Image.extend({
  name: 'image',

  addOptions() {
    return {
      ...this.parent?.(),
      uploadFn: null as ((file: File) => Promise<string>) | null,
      onUploaded: null as (() => void) | null,
      onRemoved: null as ((src: string) => void) | null,
    };
  },

  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (element: HTMLElement) => element.style.width || element.getAttribute('width') || null,
        renderHTML: (attributes: Record<string, unknown>) => {
          if (!attributes.width) return {};
          return { style: `width: ${attributes.width}` };
        },
      },
    };
  },

  // La regola markdown ![alt](src) creerebbe un'immagine remota digitando: senza uploadFn non esiste.
  addInputRules() {
    return (this.options as unknown as { uploadFn?: unknown }).uploadFn ? (this.parent?.() ?? []) : [];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ResizableImage);
  },

  addProseMirrorPlugins() {
    const opts = this.options as unknown as { uploadFn?: (file: File) => Promise<string>; onUploaded?: () => void; onRemoved?: (src: string) => void };
    const uploadFn = opts.uploadFn ?? null;
    const onUploaded = opts.onUploaded ?? null;
    const onRemoved = opts.onRemoved ?? null;
    const editor = this.editor;

    return [
      ...(this.parent?.() || []),
      new Plugin({
        key: new PluginKey('imageDrop'),
        props: {
          handleDOMEvents: {
            // nel DOM event, non in handleDrop: parte prima di posAtCoords e anche a editor non modificabile
            drop: (view, event) => {
              if (uploadFn || !(event as DragEvent).dataTransfer?.files?.length) return false;
              event.preventDefault();
              // a sola lettura (pagina pubblica) il blocco e' silenzioso: l'avviso parla del Vault
              if (view.editable) notify('vault.imagesBlocked');
              return true;
            },
          },
          transformPasted: (slice) => {
            if (uploadFn) return slice;
            const r = stripSlice(slice);
            if (r.removed) notify('vault.remoteImagesRemoved');
            return r.slice;
          },
          handleDrop: (view, event, _slice, moved) => {
            if (moved || !uploadFn) return false;

            const files = event.dataTransfer?.files;
            if (!files?.length) return false;

            const images = Array.from(files).filter((f) => f.type.startsWith('image/'));
            if (!images.length) return false;

            event.preventDefault();

            images.forEach(async (file) => {
              try {
                const url = await uploadFn(file);
                const { schema } = view.state;
                const node = schema.nodes.image.create({ src: url, alt: file.name });
                const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
                if (pos !== undefined) {
                  const tr = view.state.tr.insert(pos, node);
                  view.dispatch(tr);
                }
                onUploaded?.();
              } catch (e) {
                console.error('Image upload failed', e);
              }
            });

            return true;
          },

          handlePaste: (view, event) => {
            if (!uploadFn) {
              const cd = event.clipboardData;
              if (!cd || !Array.from(cd.items ?? []).some((i) => i.kind === 'file')) return false;
              // con testo/HTML nella clipboard (es. copia da Excel) il testo si incolla comunque, senza avviso
              if (cd.types?.includes('text/html') || cd.types?.includes('text/plain')) return false;
              event.preventDefault();
              notify('vault.imagesBlocked');
              return true;
            }

            const items = event.clipboardData?.items;
            if (!items) return false;

            const images = Array.from(items)
              .filter((item) => item.type.startsWith('image/'))
              .map((item) => item.getAsFile())
              .filter(Boolean) as File[];
            if (!images.length) return false;

            event.preventDefault();

            images.forEach(async (file) => {
              try {
                const url = await uploadFn(file);
                const { schema } = view.state;
                const node = schema.nodes.image.create({ src: url, alt: file.name });
                const tr = view.state.tr.replaceSelectionWith(node);
                view.dispatch(tr);
                onUploaded?.();
              } catch (e) {
                console.error('Image paste upload failed', e);
              }
            });

            return true;
          },
        },
      }),
      // Rete finale (F.13): immagini remote entrate senza passare da transformPasted (insertContent, menu contestuale "Incolla")
      new Plugin({
        key: new PluginKey('remoteImageGuard'),
        appendTransaction: (transactions, _old, newState) => {
          if (uploadFn || !editor.isEditable || !transactions.some((tr) => tr.docChanged)) return null;
          const found: { pos: number; size: number }[] = [];
          newState.doc.descendants((node, pos) => {
            if (node.type.name === 'image' && !isLocalImageSrc(node.attrs.src)) found.push({ pos, size: node.nodeSize });
          });
          if (!found.length) return null;
          const tr = newState.tr;
          for (const { pos, size } of found.reverse()) tr.delete(pos, pos + size);
          notify('vault.remoteImagesRemoved');
          return tr;
        },
      }),
      // Track image removals from editor body
      new Plugin({
        key: new PluginKey('imageRemovalTracker'),
        appendTransaction: (transactions, oldState, newState) => {
          if (!onRemoved) return null;

          // Only process local doc changes (skip y-sync and programmatic attachment deletions)
          const hasLocalDocChange = transactions.some(
            (tr) => tr.docChanged && !tr.getMeta('y-sync$') && !tr.getMeta('attachment-delete')
          );
          if (!hasLocalDocChange) return null;

          // Collect image srcs from old and new states
          const oldImages = new Set<string>();
          oldState.doc.descendants((node) => {
            if (node.type.name === 'image' && node.attrs.src?.startsWith('/uploads/')) {
              oldImages.add(node.attrs.src);
            }
          });

          const newImages = new Set<string>();
          newState.doc.descendants((node) => {
            if (node.type.name === 'image' && node.attrs.src?.startsWith('/uploads/')) {
              newImages.add(node.attrs.src);
            }
          });

          // Detect removed images and notify
          for (const src of oldImages) {
            if (!newImages.has(src)) {
              // Defer to avoid issues during transaction processing
              setTimeout(() => onRemoved(src), 0);
            }
          }

          return null;
        },
      }),
    ];
  },
});
