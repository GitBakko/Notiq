import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TextAlign from '@tiptap/extension-text-align';
import { Table } from '@tiptap/extension-table';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import Link from '@tiptap/extension-link';
import Underline from '@tiptap/extension-underline';
import { TextStyle } from '@tiptap/extension-text-style';
import { FontFamily } from '@tiptap/extension-font-family';
import { FontSize } from './FontSize';
import { LineHeight } from './LineHeight';
import EncryptedBlock from './extensions/EncryptedBlock';
import { ListAutoFormat } from './extensions/ListAutoFormat';
import { ImageDrop } from './extensions/ImageDrop';
import { useEffect, useRef, useMemo, useState, useCallback, forwardRef, useImperativeHandle } from 'react';
import EditorToolbar from './EditorToolbar';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { CollaborativeHighlighter } from './extensions/CollaborativeHighlighter';
import { RemoteEditTracker } from './extensions/RemoteEditTracker';
import { rowResizing } from './extensions/rowResizing';
import TableContextMenu from './TableContextMenu';
import EditorContextMenu, { extractListItems } from './EditorContextMenu';
import type { ListItemInfo } from './EditorContextMenu';
import TransformToKanbanModal from './TransformToKanbanModal';
import TransformToTaskListModal from './TransformToTaskListModal';
import { uploadAttachment } from '../../features/attachments/attachmentService';
import EditorStatusBar from './EditorStatusBar';

interface EditorProps {
  content: string;
  onChange: (content: string) => void;
  editable?: boolean;
  noteId?: string;
  onImageUploaded?: () => void;
  onImageRemoved?: (src: string) => void;
  onVoiceMemo?: () => void;
  scrollable?: boolean;
  notebookName?: string;
  isVault?: boolean;
  provider?: HocuspocusProvider | null;
  collaboration?: {
    enabled: boolean;
    documentId: string;
    token: string;
    user: {
      name: string;
      color: string;
      avatarUrl?: string | null;
    };
  };
}

export interface EditorHandle {
  focus: () => void;
  getEditor: () => any;
}

export default forwardRef<EditorHandle, EditorProps>(function Editor({ content, onChange, editable = true, noteId, onImageUploaded, onImageRemoved, onVoiceMemo, scrollable = true, notebookName, isVault, collaboration, provider }, ref) {
  const isUpdating = useRef(false);
  const isFirstUpdate = useRef(true);
  const contentRef = useRef(content);

  // Stable refs for callbacks so ProseMirror plugins always access latest versions
  const onImageUploadedRef = useRef(onImageUploaded);
  const onImageRemovedRef = useRef(onImageRemoved);
  useEffect(() => { onImageUploadedRef.current = onImageUploaded; }, [onImageUploaded]);
  useEffect(() => { onImageRemovedRef.current = onImageRemoved; }, [onImageRemoved]);

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
      Underline,
      EncryptedBlock,
      ListAutoFormat,
      ImageDrop.configure({
        inline: true,
        allowBase64: false,
        uploadFn: noteId
          ? async (file: File) => {
              const attachment = await uploadAttachment(noteId, file);
              return attachment.url.startsWith('/') ? attachment.url : '/uploads/' + attachment.filename;
            }
          : undefined,
        onUploaded: () => onImageUploadedRef.current?.(),
        onRemoved: (src: string) => onImageRemovedRef.current?.(src),
      } as any),
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
      extensionsWithCollab.push(RemoteEditTracker);

      return extensionsWithCollab;
    }

    return baseExtensions;
  }, [provider, collaboration?.enabled, collaboration?.user, noteId]);

  // Parse JSON string to object for TipTap (it treats strings as HTML)
  const parsedInitialContent = useMemo(() => {
    if (collaboration?.enabled || !content) return undefined;
    try {
      const json = JSON.parse(content);
      if (typeof json === 'object' && json !== null) return json;
    } catch (e) { /* not JSON, treat as HTML */ }
    return content;
  }, []); // Only compute once on mount — sync effect handles updates

  const editor = useEditor({
    extensions,
    content: parsedInitialContent,
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
        class: 'prose prose-sm focus:outline-none min-h-[500px] px-8 py-4 dark:prose-invert max-w-none w-full break-words',
      },
      handleKeyDown: (view, event) => {
        if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === 'V' || event.key === 'v')) {
          event.preventDefault();
          navigator.clipboard.readText().then((text) => {
            if (text) view.dispatch(view.state.tr.insertText(text));
          }).catch(() => {});
          return true;
        }
        return false;
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

  // -- Editor stats for status bar --
  const [editorStats, setEditorStats] = useState({ characters: 0, lines: 0, cursorLine: 1, cursorColumn: 1 });

  useEffect(() => {
    if (!editor) return;
    const computeStats = () => {
      const { doc, selection } = editor.state;
      const { $anchor } = selection;

      let lineCount = 0;
      let cursorLine = 1;
      let found = false;

      doc.descendants((node, pos) => {
        if (node.isTextblock) {
          if (node.type.name === 'codeBlock') {
            const codeLines = node.textContent.split('\n').length;
            lineCount += codeLines;
            if (!found && $anchor.pos >= pos && $anchor.pos <= pos + node.nodeSize) {
              const textBefore = node.textContent.substring(0, $anchor.parentOffset);
              cursorLine = lineCount - codeLines + 1 + textBefore.split('\n').length - 1;
              found = true;
            }
          } else {
            lineCount += 1;
            if (!found && $anchor.pos >= pos && $anchor.pos <= pos + node.nodeSize) {
              cursorLine = lineCount;
              found = true;
            }
          }
        }
        return true;
      });

      setEditorStats({
        characters: doc.textContent.length,
        lines: lineCount || 1,
        cursorLine: found ? cursorLine : 1,
        cursorColumn: $anchor.parentOffset + 1,
      });
    };

    editor.on('update', computeStats);
    editor.on('selectionUpdate', computeStats);
    computeStats();
    return () => {
      editor.off('update', computeStats);
      editor.off('selectionUpdate', computeStats);
    };
  }, [editor]);

  // Context menu state
  const [tableContextMenu, setTableContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [editorContextMenu, setEditorContextMenu] = useState<{ x: number; y: number } | null>(null);

  // Transform modals state
  const [kanbanTransformItems, setKanbanTransformItems] = useState<ListItemInfo[] | null>(null);
  const [taskListTransformItems, setTaskListTransformItems] = useState<ListItemInfo[] | null>(null);

  // Keyboard shortcuts: Ctrl+Shift+K → Kanban, Ctrl+Shift+L → Task List
  useEffect(() => {
    if (!editor || !editable) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey) return;
      if (e.key === 'K' || e.key === 'k') {
        e.preventDefault();
        const items = extractListItems(editor);
        if (items.length > 0) setKanbanTransformItems(items);
      } else if (e.key === 'L' || e.key === 'l') {
        e.preventDefault();
        const items = extractListItems(editor);
        if (items.length > 0) setTaskListTransformItems(items);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [editor, editable]);

  const handleEditorContextMenu = useCallback((e: React.MouseEvent) => {
    if (editor?.isActive('table')) {
      e.preventDefault();
      setTableContextMenu({ x: e.clientX, y: e.clientY });
    } else if (editor && editable) {
      e.preventDefault();
      setEditorContextMenu({ x: e.clientX, y: e.clientY });
    }
  }, [editor, editable]);

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
        {editable && (
          <EditorStatusBar
            {...editorStats}
            notebookName={notebookName}
            isVault={isVault}
          />
        )}
        {editable && tableContextMenu && (
          <TableContextMenu
            editor={editor}
            position={tableContextMenu}
            onClose={() => setTableContextMenu(null)}
          />
        )}
        {editable && editorContextMenu && (
          <EditorContextMenu
            editor={editor}
            position={editorContextMenu}
            onClose={() => setEditorContextMenu(null)}
            onTransformToKanban={(items) => setKanbanTransformItems(items)}
            onTransformToTaskList={(items) => setTaskListTransformItems(items)}
          />
        )}
        {editor && kanbanTransformItems && (
          <TransformToKanbanModal
            isOpen={true}
            onClose={() => setKanbanTransformItems(null)}
            items={kanbanTransformItems}
            editor={editor}
          />
        )}
        {editor && taskListTransformItems && (
          <TransformToTaskListModal
            isOpen={true}
            onClose={() => setTaskListTransformItems(null)}
            items={taskListTransformItems}
            editor={editor}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      {editable && <EditorToolbar editor={editor} onVoiceMemo={onVoiceMemo} provider={provider} />}
      <div className="flex-1 overflow-auto min-w-0 min-h-0" onContextMenu={handleEditorContextMenu}>
        <EditorContent editor={editor} />
      </div>
      {editable && (
        <EditorStatusBar
          {...editorStats}
          notebookName={notebookName}
          isVault={isVault}
        />
      )}
      {editable && tableContextMenu && (
        <TableContextMenu
          editor={editor}
          position={tableContextMenu}
          onClose={() => setTableContextMenu(null)}
        />
      )}
      {editable && editorContextMenu && (
        <EditorContextMenu
          editor={editor}
          position={editorContextMenu}
          onClose={() => setEditorContextMenu(null)}
          onTransformToKanban={(items) => setKanbanTransformItems(items)}
          onTransformToTaskList={(items) => setTaskListTransformItems(items)}
        />
      )}
      {editor && kanbanTransformItems && (
        <TransformToKanbanModal
          isOpen={true}
          onClose={() => setKanbanTransformItems(null)}
          items={kanbanTransformItems}
          editor={editor}
        />
      )}
      {editor && taskListTransformItems && (
        <TransformToTaskListModal
          isOpen={true}
          onClose={() => setTaskListTransformItems(null)}
          items={taskListTransformItems}
          editor={editor}
        />
      )}
    </div>
  );
});
