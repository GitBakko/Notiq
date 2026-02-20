import Image from '@tiptap/extension-image';
import { Plugin, PluginKey } from '@tiptap/pm/state';

export const ImageDrop = Image.extend({
  name: 'image',

  addOptions() {
    return {
      ...this.parent?.(),
      uploadFn: null as ((file: File) => Promise<string>) | null,
    };
  },

  addProseMirrorPlugins() {
    const uploadFn = (this.options as any).uploadFn as ((file: File) => Promise<string>) | null;

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
              } catch (e) {
                console.error('Image paste upload failed', e);
              }
            });

            return true;
          },
        },
      }),
    ];
  },
});
