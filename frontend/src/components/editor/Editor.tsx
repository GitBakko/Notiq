import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TextAlign from '@tiptap/extension-text-align';
import { Table } from '@tiptap/extension-table';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import Link from '@tiptap/extension-link';
import { TextStyle } from '@tiptap/extension-text-style';
import { FontFamily } from '@tiptap/extension-font-family';
import { FontSize } from './FontSize';
import { LineHeight } from './LineHeight';
import EncryptedBlock from './extensions/EncryptedBlock';
import { useEffect, useRef, useMemo, useState, useCallback, forwardRef, useImperativeHandle } from 'react';
import EditorToolbar from './EditorToolbar';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { CollaborativeHighlighter } from './extensions/CollaborativeHighlighter';
import { rowResizing } from './extensions/rowResizing';
import TableContextMenu from './TableContextMenu';

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

export interface EditorHandle {
  focus: () => void;
  getEditor: () => any;
}

export default forwardRef<EditorHandle, EditorProps>(function Editor({ content, onChange, editable = true, onVoiceMemo, scrollable = true, collaboration, provider }, ref) {
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
        history: collaboration?.enabled ? false : undefined, // Disable history if collaboration is enabled (Yjs handles it)
      }),
      TextAlign.configure({
        types: ['heading', 'paragraph'],
      }),
      Table.extend({
        addAttributes() {
          return {
            ...this.parent?.(),
            tableWidth: {
              default: null, // null = AUTO (100%), 'free' = column-based
              parseHTML: (element: HTMLElement) => {
                const w = element.getAttribute('data-table-width');
                if (w === 'free') return 'free';
                return null; // default AUTO
              },
              renderHTML: (attributes: Record<string, any>) => {
                if (attributes.tableWidth === 'free') {
                  return { 'data-table-width': 'free' };
                }
                return { style: 'width: 100%' }; // AUTO
              },
            },
          };
        },
        addProseMirrorPlugins() {
          return [
            ...(this.parent?.() || []),
            new Plugin({
              key: new PluginKey('tableWidthApply'),
              view: () => ({
                update: (view, prevState) => {
                  if (prevState && view.state.doc === prevState.doc) return;
                  view.state.doc.descendants((node, pos) => {
                    if (node.type.name === 'table') {
                      const dom = view.nodeDOM(pos);
                      if (dom instanceof HTMLElement) {
                        const table = dom.tagName === 'TABLE' ? dom : dom.querySelector('table');
                        if (table instanceof HTMLElement) {
                          if (node.attrs.tableWidth === 'free') {
                            // FREE: let prosemirror-tables' TableView manage width
                          } else {
                            // AUTO (null/default): fill container
                            table.style.width = '100%';
                            table.style.minWidth = '';
                          }
                        }
                      }
                    }
                  });
                },
              }),
            }),
            rowResizing({ handleHeight: 5 }),
          ];
        },
      }).configure({
        resizable: true,
      }),
      TableRow.extend({
        addAttributes() {
          return {
            ...this.parent?.(),
            rowHeight: {
              default: null,
              parseHTML: (element: HTMLElement) => {
                const h = element.style.height;
                return (h && h !== 'auto') ? h : null;
              },
              renderHTML: (attributes: Record<string, any>) => {
                if (!attributes.rowHeight) return {};
                return { style: `height: ${attributes.rowHeight}` };
              },
            },
          };
        },
      }),
      TableHeader.extend({
        addAttributes() {
          return {
            ...this.parent?.(),
            borderStyle: {
              default: null,
              parseHTML: (element: HTMLElement) => element.style.borderStyle,
              renderHTML: (attributes: Record<string, any>) => {
                if (!attributes.borderStyle) return {};
                return { style: `border-style: ${attributes.borderStyle}` };
              },
            },
            borderColor: {
              default: null,
              parseHTML: (element: HTMLElement) => element.style.borderColor,
              renderHTML: (attributes: Record<string, any>) => {
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
              parseHTML: (element: HTMLElement) => element.style.borderStyle,
              renderHTML: (attributes: Record<string, any>) => {
                if (!attributes.borderStyle) return {};
                return { style: `border-style: ${attributes.borderStyle}` };
              },
            },
            borderColor: {
              default: null,
              parseHTML: (element: HTMLElement) => element.style.borderColor,
              renderHTML: (attributes: Record<string, any>) => {
                if (!attributes.borderColor) return {};
                return { style: `border-color: ${attributes.borderColor}` };
              },
            },
          };
        },
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
      }),
      TextStyle,
      FontFamily,
      FontSize,
      LineHeight,
      EncryptedBlock,
    ];

    if (collaboration?.enabled && provider && provider.document) {
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
    content: collaboration?.enabled ? undefined : content, // Ignore initial content if collaboration is enabled
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
        class: 'prose prose-sm sm:prose lg:prose-lg xl:prose-2xl focus:outline-none min-h-[500px] px-8 py-4 dark:prose-invert max-w-none w-full break-words leading-relaxed',
      },
    },
  }, [provider]); // Re-initialize when provider changes

  // Expose focus method
  useImperativeHandle(ref, () => ({
    focus: () => {
      editor?.commands.focus('start');
    },
    getEditor: () => editor,
  }));

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
        // Only inject content if the editor is empty AND the provided content is substantial
        // AND we haven't already synced (which this callback should ensure)
        if (editor.isEmpty) {
          const currentContent = contentRef.current;

          // Improved check for "empty" content
          const isPassedContentEmpty = !currentContent ||
            currentContent === '<p></p>' ||
            currentContent === '{"type":"doc","content":[{"type":"paragraph"}]}' ||
            currentContent === '' ||
            (typeof currentContent === 'string' && currentContent.trim() === '');

          if (!isPassedContentEmpty) {
            // Check if Yjs actually has content (provider.document is the Y.Doc)
            // Tiptap syncs Y.XmlFragment 'default'
            // @ts-ignore
            const yXmlFragment = provider.document.getXmlFragment('default');
            const yDocHasContent = yXmlFragment.length > 0;

            if (!yDocHasContent) {
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

  // Table context menu state
  const [tableContextMenu, setTableContextMenu] = useState<{ x: number; y: number } | null>(null);

  const handleEditorContextMenu = useCallback((e: React.MouseEvent) => {
    if (!editor?.isActive('table')) return;
    e.preventDefault();
    setTableContextMenu({ x: e.clientX, y: e.clientY });
  }, [editor]);

  if (!editor) {
    return null;
  }

  if (!scrollable) {
    return (
      <div className="w-full">
        {editable && <EditorToolbar editor={editor} onVoiceMemo={onVoiceMemo} provider={provider} />}
        <div onContextMenu={handleEditorContextMenu}>
          <EditorContent editor={editor} />
        </div>
        {editable && tableContextMenu && (
          <TableContextMenu
            editor={editor}
            position={tableContextMenu}
            onClose={() => setTableContextMenu(null)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-w-0">
      {editable && <EditorToolbar editor={editor} onVoiceMemo={onVoiceMemo} provider={provider} />}
      <div className="flex-1 overflow-auto min-w-0" onContextMenu={handleEditorContextMenu}>
        <EditorContent editor={editor} />
      </div>
      {editable && tableContextMenu && (
        <TableContextMenu
          editor={editor}
          position={tableContextMenu}
          onClose={() => setTableContextMenu(null)}
        />
      )}
    </div>
  );
});
