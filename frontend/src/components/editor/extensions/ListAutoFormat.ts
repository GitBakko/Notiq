import { Extension } from '@tiptap/core';
import { wrappingInputRule } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';

export const ListAutoFormat = Extension.create({
  name: 'listAutoFormat',

  addInputRules() {
    const bulletListType = this.editor.schema.nodes.bulletList;
    const orderedListType = this.editor.schema.nodes.orderedList;

    return [
      // degree symbol (°) followed by space -> bullet list
      wrappingInputRule({
        find: /^\s*(\u00B0)\s$/,
        type: bulletListType,
      }),
      // N) followed by space -> ordered list starting at N
      wrappingInputRule({
        find: /^\s*(\d+)\)\s$/,
        type: orderedListType,
        getAttributes: (match) => ({ start: +match[1] }),
      }),
      // N- followed by space -> ordered list starting at N
      wrappingInputRule({
        find: /^\s*(\d+)-\s$/,
        type: orderedListType,
        getAttributes: (match) => ({ start: +match[1] }),
      }),
    ];
  },

  addKeyboardShortcuts() {
    return {
      Backspace: ({ editor }) => {
        const { state } = editor;
        const { selection } = state;

        // Only handle cursor selections (not range)
        if (!selection.empty) return false;

        const { $from } = selection;

        // Must be at the very start of the text block
        if ($from.parentOffset !== 0) return false;

        // Find the closest listItem ancestor
        let listItemDepth = -1;
        for (let d = $from.depth; d > 0; d--) {
          if ($from.node(d).type.name === 'listItem') {
            listItemDepth = d;
            break;
          }
        }
        if (listItemDepth === -1) return false;

        const listItem = $from.node(listItemDepth);

        // Only handle empty list items
        if (listItem.textContent.length > 0) return false;

        // Get the parent list
        const listDepth = listItemDepth - 1;
        if (listDepth < 0) return false;
        const list = $from.node(listDepth);

        // Only handle top-level lists (not nested inside another list item)
        if (listDepth > 0 && $from.node(listDepth - 1)?.type.name === 'listItem') {
          return false;
        }

        // Determine the trigger text based on list type
        let triggerText: string;
        if (list.type.name === 'bulletList') {
          triggerText = '- ';
        } else if (list.type.name === 'orderedList') {
          const start = list.attrs.start || 1;
          const itemIndex = $from.index(listDepth);
          triggerText = `${start + itemIndex}. `;
        } else {
          return false;
        }

        // Replace the list item with a paragraph containing the trigger text.
        // Using a direct transaction (not editor commands) to avoid re-triggering InputRules.
        const { tr } = state;

        if (list.childCount === 1) {
          // Only item in the list — replace the entire list with a paragraph
          const listStart = $from.before(listDepth);
          const listEnd = $from.after(listDepth);
          const paragraph = state.schema.nodes.paragraph.create(
            null,
            state.schema.text(triggerText)
          );
          tr.replaceWith(listStart, listEnd, paragraph);
          // Place cursor at end of trigger text (listStart + 1 for paragraph open + triggerText length)
          const cursorPos = listStart + 1 + triggerText.length;
          tr.setSelection(TextSelection.create(tr.doc, cursorPos));
        } else {
          // Multiple items — lift this item out and replace with trigger text
          const itemStart = $from.before(listItemDepth);
          const itemEnd = $from.after(listItemDepth);
          const paragraph = state.schema.nodes.paragraph.create(
            null,
            state.schema.text(triggerText)
          );
          tr.replaceWith(itemStart, itemEnd, paragraph);
          const cursorPos = itemStart + 1 + triggerText.length;
          tr.setSelection(TextSelection.create(tr.doc, cursorPos));
        }

        editor.view.dispatch(tr);
        return true;
      },
    };
  },
});
