import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, EditorView } from '@tiptap/pm/view';

const rowResizingPluginKey = new PluginKey('rowResizing');

interface RowResizeState {
  activeHandle: number; // ProseMirror position of the table row, or -1
  dragging: { startY: number; startHeight: number } | null;
}

/** Walk up from a DOM target to find the closest <tr> */
function domRowAround(target: EventTarget | null): HTMLTableRowElement | null {
  let node = target as HTMLElement | null;
  while (node && node.nodeName !== 'TR') {
    if (node.nodeName === 'TABLE' || node.classList?.contains('ProseMirror')) return null;
    node = node.parentElement;
  }
  return node as HTMLTableRowElement | null;
}

/** Find the ProseMirror position of a tableRow from its DOM <tr> */
function rowPosFromDOM(view: EditorView, rowDom: HTMLTableRowElement): number | null {
  const pos = view.posAtDOM(rowDom, 0);
  if (pos == null) return null;
  const $pos = view.state.doc.resolve(pos);
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.name === 'tableRow') {
      return $pos.before(d);
    }
  }
  return null;
}

/** Check if mouse is within handleHeight px of the bottom border of a row */
function isNearRowBorder(event: MouseEvent, rowDom: HTMLTableRowElement, handleHeight: number): boolean {
  const rect = rowDom.getBoundingClientRect();
  return Math.abs(event.clientY - rect.bottom) <= handleHeight;
}

/** Commit row height to ProseMirror doc */
function updateRowHeight(view: EditorView, rowPos: number, height: number): void {
  const node = view.state.doc.nodeAt(rowPos);
  if (!node || node.type.name !== 'tableRow') return;
  const tr = view.state.tr.setNodeMarkup(rowPos, undefined, {
    ...node.attrs,
    rowHeight: `${Math.max(24, Math.round(height))}px`,
  });
  if (tr.docChanged) view.dispatch(tr);
}

export function rowResizing({ handleHeight = 5 } = {}) {
  return new Plugin<RowResizeState>({
    key: rowResizingPluginKey,

    state: {
      init(): RowResizeState {
        return { activeHandle: -1, dragging: null };
      },
      apply(tr, state): RowResizeState {
        const action = tr.getMeta(rowResizingPluginKey);
        if (action && action.setHandle != null) {
          return { activeHandle: action.setHandle, dragging: null };
        }
        if (action && action.setDragging !== undefined) {
          return { activeHandle: state.activeHandle, dragging: action.setDragging };
        }
        // Remap handle position if document changed
        if (state.activeHandle > -1 && tr.docChanged) {
          const handle = tr.mapping.map(state.activeHandle, -1);
          if (handle < 0) return { activeHandle: -1, dragging: state.dragging };
          return { activeHandle: handle, dragging: state.dragging };
        }
        return state;
      },
    },

    props: {
      attributes(state) {
        const pluginState = rowResizingPluginKey.getState(state);
        if (pluginState && (pluginState.activeHandle > -1 || pluginState.dragging)) {
          return { class: 'resize-row-cursor' };
        }
        return {};
      },

      handleDOMEvents: {
        mousemove(view: EditorView, event: MouseEvent) {
          if (!view.editable) return false;
          const pluginState = rowResizingPluginKey.getState(view.state);
          if (!pluginState) return false;

          // During drag, ignore handle detection
          if (pluginState.dragging) return false;

          const rowDom = domRowAround(event.target);
          let handle = -1;

          if (rowDom && isNearRowBorder(event, rowDom, handleHeight)) {
            const pos = rowPosFromDOM(view, rowDom);
            if (pos !== null) handle = pos;
          }

          if (handle !== pluginState.activeHandle) {
            view.dispatch(
              view.state.tr.setMeta(rowResizingPluginKey, { setHandle: handle })
            );
          }
          return false;
        },

        mouseleave(view: EditorView) {
          if (!view.editable) return false;
          const pluginState = rowResizingPluginKey.getState(view.state);
          if (pluginState && pluginState.activeHandle > -1 && !pluginState.dragging) {
            view.dispatch(
              view.state.tr.setMeta(rowResizingPluginKey, { setHandle: -1 })
            );
          }
          return false;
        },

        mousedown(view: EditorView, event: MouseEvent) {
          if (!view.editable) return false;
          const pluginState = rowResizingPluginKey.getState(view.state);
          if (!pluginState || pluginState.activeHandle === -1 || pluginState.dragging) {
            return false;
          }

          const rowDom = domRowAround(event.target);
          if (!rowDom) return false;

          // Verify still near border
          if (!isNearRowBorder(event, rowDom, handleHeight)) return false;

          event.preventDefault();

          const startHeight = rowDom.getBoundingClientRect().height;
          const rowPos = pluginState.activeHandle;

          view.dispatch(
            view.state.tr.setMeta(rowResizingPluginKey, {
              setDragging: { startY: event.clientY, startHeight },
            })
          );

          const win = view.dom.ownerDocument.defaultView || window;
          const startY = event.clientY;

          function move(e: MouseEvent) {
            if (!e.buttons) {
              finish(e);
              return;
            }
            const offset = e.clientY - startY;
            const newHeight = Math.max(24, startHeight + offset);
            // Live preview via direct DOM manipulation
            rowDom.style.height = `${newHeight}px`;
          }

          function finish(e: MouseEvent) {
            win.removeEventListener('mouseup', finish);
            win.removeEventListener('mousemove', move);

            const ps = rowResizingPluginKey.getState(view.state);
            if (ps?.dragging) {
              const offset = e.clientY - startY;
              const finalHeight = Math.max(24, startHeight + offset);
              updateRowHeight(view, rowPos, finalHeight);
              view.dispatch(
                view.state.tr.setMeta(rowResizingPluginKey, { setDragging: null })
              );
            }
          }

          win.addEventListener('mousemove', move);
          win.addEventListener('mouseup', finish);

          return true;
        },
      },

      decorations(state) {
        const pluginState = rowResizingPluginKey.getState(state);
        if (!pluginState || pluginState.activeHandle === -1) {
          return DecorationSet.empty;
        }
        const node = state.doc.nodeAt(pluginState.activeHandle);
        if (!node || node.type.name !== 'tableRow') return DecorationSet.empty;

        const pos = pluginState.activeHandle;
        const end = pos + node.nodeSize;
        return DecorationSet.create(state.doc, [
          Decoration.node(pos, end, { class: 'row-resize-active' }),
        ]);
      },
    },
  });
}
