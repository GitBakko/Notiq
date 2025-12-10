import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TextAlign from '@tiptap/extension-text-align';
import { Table } from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
// import Link from '@tiptap/extension-link';
import { TextStyle } from '@tiptap/extension-text-style';
import { FontFamily } from '@tiptap/extension-font-family';
import { FontSize } from './FontSize';
import { LineHeight } from './LineHeight';
import EncryptedBlock from './extensions/EncryptedBlock';
import { useEffect, useRef, useMemo } from 'react';
import EditorToolbar from './EditorToolbar';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';
import BubbleMenu from '@tiptap/extension-bubble-menu';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { CollaborativeHighlighter } from './extensions/CollaborativeHighlighter';
import TableBubbleMenu from './TableBubbleMenu';

interface EditorProps {
  content: string;
  onChange: (content: string) => void;
  editable?: boolean;
  onVoiceMemo?: () => void;
  scrollable?: boolean;
  provider?: HocuspocusProvider | null;
  collaboration?: {
    enabled: boolean;
    documentId: string;
    token: string;
    user: {
      name: string;
      color: string;
    };
  };
}

export default function Editor({ content, onChange, editable = true, onVoiceMemo, scrollable = true, collaboration, provider }: EditorProps) {
  const isUpdating = useRef(false);
  const isFirstUpdate = useRef(true);
  const contentRef = useRef(content);

  // Update content ref
  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  // Reset first update flag when provider changes
  useEffect(() => {
    isFirstUpdate.current = true;
  }, [provider]);

  const extensions = useMemo(() => {
    const baseExtensions = [
      StarterKit.configure({
        // @ts-ignore
        undoRedo: !collaboration?.enabled, // Disable history if collaboration is enabled (Yjs handles it)
        link: {
          openOnClick: false,
          autolink: true,
        },
      }),
      TextAlign.configure({
        types: ['heading', 'paragraph'],
      }),
      Table.configure({
        resizable: true,
      }),
      TableRow,
      TableHeader.extend({
        addAttributes() {
          return {
            ...this.parent?.(),
            borderStyle: {
              default: null,
              parseHTML: element => element.style.borderStyle,
              renderHTML: attributes => {
                if (!attributes.borderStyle) return {};
                return { style: `border-style: ${attributes.borderStyle}` };
              },
            },
            borderColor: {
              default: null,
              parseHTML: element => element.style.borderColor,
              renderHTML: attributes => {
                if (!attributes.borderColor) return {};
                return { style: `border-color: ${attributes.borderColor}` };
              },
            },
          };
        },
      }),
      TableCell.extend({
        addAttributes() {
          return {
            ...this.parent?.(),
            borderStyle: {
              default: null,
              parseHTML: element => element.style.borderStyle,
              renderHTML: attributes => {
                if (!attributes.borderStyle) return {};
                return { style: `border-style: ${attributes.borderStyle}` };
              },
            },
            borderColor: {
              default: null,
              parseHTML: element => element.style.borderColor,
              renderHTML: attributes => {
                if (!attributes.borderColor) return {};
                return { style: `border-color: ${attributes.borderColor}` };
              },
            },
          };
        },
      }),
      // Link.configure({
      //   openOnClick: false,
      //   autolink: true,
      // }),
      TextStyle,
      FontFamily,
      FontSize,
      LineHeight,
      EncryptedBlock,
      BubbleMenu.configure({
        pluginKey: 'bubbleMenu',
      }),
    ];

    if (collaboration?.enabled && provider && provider.document) {
      console.log('Editor: Configuring collaboration', { provider, doc: provider.document, user: collaboration.user });
      const extensionsWithCollab = [
        ...baseExtensions,
        Collaboration.configure({
          document: provider.document,
        }),
      ];

      if (provider.awareness) {
        // Ensure provider has doc property (HocuspocusProvider has .document)
        // Some extensions (like CollaborationCursor) might expect .doc
        if (provider && !('doc' in provider)) {
          Object.assign(provider, { doc: provider.document });
        }

        extensionsWithCollab.push(
          CollaborationCursor.configure({
            provider: provider,
            user: collaboration.user,
          }) as any
        );
      }

      extensionsWithCollab.push(CollaborativeHighlighter);

      return extensionsWithCollab;
    }

    return baseExtensions;
  }, [provider, collaboration?.enabled, collaboration?.user]);

  const editor = useEditor({
    extensions,
    content: collaboration?.enabled ? undefined : content, // Ignore initial content if collaboration is enabled (syncs from server)
    editable,
    onUpdate: ({ editor }) => {
      isUpdating.current = true;
      // Save as JSON string
      onChange(JSON.stringify(editor.getJSON()));
      setTimeout(() => {
        isUpdating.current = false;
      }, 0);
    },
    editorProps: {
      attributes: {
        class: 'prose prose-sm sm:prose lg:prose-lg xl:prose-2xl focus:outline-none min-h-[500px] px-8 py-4 dark:prose-invert max-w-none w-full',
      },
    },
  }, [provider]); // Re-initialize when provider changes

  // Sync editable state
  useEffect(() => {
    if (editor) {
      editor.setEditable(editable);
    }
  }, [editable, editor]);

  // Sync content updates from parent
  useEffect(() => {
    if (editor && content && !isUpdating.current) {
      let parsedContent: any = content;
      try {
        // Try to parse as JSON, if fails, treat as HTML string
        const json = JSON.parse(content);
        if (typeof json === 'object' && json !== null) {
          parsedContent = json;
        }
      } catch (e) {
        // Not JSON, assume HTML
      }

      // If collaboration is disabled, always sync
      if (!collaboration?.enabled) {
        // Compare current content with passed content
        // We need to be careful not to trigger infinite loops
        // If parsedContent is object (JSON), we compare with editor.getJSON()
        // If parsedContent is string (HTML), we compare with editor.getHTML()

        if (typeof parsedContent === 'object') {
          if (JSON.stringify(editor.getJSON()) !== JSON.stringify(parsedContent)) {
            editor.commands.setContent(parsedContent);
          }
        } else {
          if (editor.getHTML() !== content) {
            editor.commands.setContent(parsedContent);
          }
        }
      }
    }
  }, [content, editor, collaboration?.enabled]);

  // Handle initial content injection for collaboration
  useEffect(() => {
    if (provider && editor && collaboration?.enabled) {
      const handleSync = () => {
        if (editor.isEmpty) {
          const currentContent = contentRef.current;
          const isPassedContentEmpty = !currentContent ||
            currentContent === '<p></p>' ||
            currentContent === '{"type":"doc","content":[{"type":"paragraph"}]}' ||
            currentContent === '';

          if (!isPassedContentEmpty) {
            let contentToSet: any = currentContent;
            try {
              const json = JSON.parse(currentContent);
              if (typeof json === 'object' && json !== null) {
                contentToSet = json;
              }
            } catch (e) { }

            try {
              editor.commands.setContent(contentToSet);
            } catch (err) {
              console.error('Editor: Injection failed', err);
            }
          }
        }
      };

      if (provider.synced) {
        handleSync();
      } else {
        provider.on('synced', handleSync);
      }

      return () => { provider.off('synced', handleSync); };
    }
  }, [provider, editor, collaboration?.enabled]);

  if (!editor) {
    return null;
  }

  if (!scrollable) {
    return (
      <div className="w-full">
        {editable && <EditorToolbar editor={editor} onVoiceMemo={onVoiceMemo} provider={provider} />}
        {editable && <TableBubbleMenu editor={editor} />}
        <EditorContent editor={editor} />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {editable && <EditorToolbar editor={editor} onVoiceMemo={onVoiceMemo} provider={provider} />}
      {editable && <TableBubbleMenu editor={editor} />}
      <div className="flex-1 overflow-y-auto">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
