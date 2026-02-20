import { Extension } from '@tiptap/core';
import { wrappingInputRule } from '@tiptap/core';

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
});
