import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

const highlightPluginKey = new PluginKey('collaborativeHighlighter');

export const CollaborativeHighlighter = Extension.create({
  name: 'collaborativeHighlighter',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: highlightPluginKey,
        state: {
          init() {
            return DecorationSet.empty;
          },
          apply(tr, set) {
            // Adjust existing decorations to map to new document state
            set = set.map(tr.mapping, tr.doc);

            // Handle cleanup
            if (tr.getMeta('clear-highlights')) {
              return DecorationSet.empty;
            }

            // Check if transaction is from a remote user (Yjs usually adds 'y-sync$' or similar meta)
            const isRemote = tr.getMeta('y-sync$');

            if (isRemote) {
              const decorations: Decoration[] = [];

              tr.steps.forEach((step) => {
                step.getMap().forEach((oldStart, oldEnd, newStart, newEnd) => {
                  // Insertion
                  if (newEnd > newStart) {
                    decorations.push(
                      Decoration.inline(newStart, newEnd, {
                        class: 'remote-change-add',
                      })
                    );
                  }

                  // Deletion
                  if (oldEnd > oldStart) {
                    const deletedContent = tr.before.textBetween(oldStart, oldEnd);
                    const docSize = tr.before.content.size;
                    const isFullReplacement = (oldEnd - oldStart) > (docSize * 0.9);

                    if (deletedContent && !isFullReplacement) {
                      // Create a widget that shows the deleted text
                      const element = document.createElement('span');
                      element.textContent = deletedContent;
                      element.className = 'remote-change-delete';

                      decorations.push(
                        Decoration.widget(newStart, element, {
                          side: 0,
                        })
                      );
                    }
                  }
                });
              });

              if (decorations.length > 0) {
                set = set.add(tr.doc, decorations);
              }
            }

            return set;
          },
        },
        props: {
          decorations(state) {
            return highlightPluginKey.getState(state);
          },
        },
        view() {
          let timeout: ReturnType<typeof setTimeout>;

          return {
            update(view) {
              const state = highlightPluginKey.getState(view.state);
              // If we have decorations, schedule a cleanup
              if (state && state.find().length > 0) {
                clearTimeout(timeout);
                timeout = setTimeout(() => {
                  if (!view.isDestroyed) {
                    const tr = view.state.tr;
                    tr.setMeta('clear-highlights', true);
                    view.dispatch(tr);
                  }
                }, 4000); // Clear after 4 seconds (giving CSS animation 3s to finish)
              }
            },
            destroy() {
              clearTimeout(timeout);
            }
          }
        },
      }),
    ];
  },
});
