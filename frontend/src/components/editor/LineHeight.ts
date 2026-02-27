import { Extension } from '@tiptap/core';

export interface LineHeightOptions {
  types: string[];
  defaultLineHeight: string | null;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    lineHeight: {
      setLineHeight: (lineHeight: string) => ReturnType;
      unsetLineHeight: () => ReturnType;
    };
  }
}

export const LineHeight = Extension.create<LineHeightOptions>({
  name: 'lineHeight',

  addOptions() {
    return {
      types: ['paragraph', 'heading'],
      defaultLineHeight: null as string | null,
    };
  },

  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          lineHeight: {
            default: this.options.defaultLineHeight,
            parseHTML: (element) => element.style.lineHeight || null,
            renderHTML: (attributes) => {
              if (!attributes.lineHeight || parseFloat(attributes.lineHeight) < 1) {
                return {};
              }
              return {
                style: `line-height: ${attributes.lineHeight}`,
              };
            },
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setLineHeight:
        (lineHeight: string) =>
          ({ commands }) => {
            return this.options.types.some((type) =>
              commands.updateAttributes(type, { lineHeight })
            );
          },
      unsetLineHeight:
        () =>
          ({ commands }) => {
            return this.options.types.some((type) =>
              commands.resetAttributes(type, 'lineHeight')
            );
          },
    };
  },
});
