import { BubbleMenuPlugin, type BubbleMenuPluginProps } from '@tiptap/extension-bubble-menu';
import { Editor } from '@tiptap/react';
import React, { useEffect, useState } from 'react';

export interface BubbleMenuProps extends Omit<BubbleMenuPluginProps, 'pluginKey' | 'editor' | 'element'> {
  editor: Editor;
  className?: string;
  children: React.ReactNode;
  pluginKey?: string | any;
  tippyOptions?: any;
  updateDelay?: number;
}

export const BubbleMenu = (props: BubbleMenuProps) => {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const { editor, pluginKey = 'bubbleMenu', shouldShow, tippyOptions, updateDelay, className, children } = props;

  useEffect(() => {
    if (!element || !editor) {
      return;
    }

    if (editor.isDestroyed) {
      return;
    }

    const plugin = BubbleMenuPlugin({
      pluginKey,
      editor,
      element,
      tippyOptions,
      shouldShow,
      updateDelay,
    } as any);

    editor.registerPlugin(plugin);

    return () => {
      editor.unregisterPlugin(pluginKey);
    };
  }, [editor, element, pluginKey, shouldShow, tippyOptions, updateDelay]);

  return (
    <div ref={setElement} className={className} style={{ visibility: 'hidden' }}>
      {children}
    </div>
  );
};

export default BubbleMenu;
