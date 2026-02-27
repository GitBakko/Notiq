import Image from '@tiptap/extension-image';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { ResizableImage } from './ResizableImage';

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

  addNodeView() {
    return ReactNodeViewRenderer(ResizableImage);
  },

  addProseMirrorPlugins() {
    const opts = this.options as unknown as { uploadFn?: (file: File) => Promise<string>; onUploaded?: () => void; onRemoved?: (src: string) => void };
    const uploadFn = opts.uploadFn ?? null;
    const onUploaded = opts.onUploaded ?? null;
    const onRemoved = opts.onRemoved ?? null;

    return [
      ...(this.parent?.() || []),
      new Plugin({
        key: new PluginKey('imageDrop'),
        props: {
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
            if (!uploadFn) return false;

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
