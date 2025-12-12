import { useState, useEffect, useRef, useMemo } from 'react';
import { Share2, ArrowLeft, Star, Trash2, MessageSquare, Paperclip, Users, Lock } from 'lucide-react';
import Editor from '../../components/editor/Editor';
import { revokeShare, type Note } from './noteService';
import { useDebounce } from '../../hooks/useDebounce';
import { uploadAttachment, deleteAttachment } from '../attachments/attachmentService';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import TagSelector from '../../components/editor/TagSelector';
import { useNotebooks } from '../../hooks/useNotebooks';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../../store/authStore';

import SharingModal from '../../components/sharing/SharingModal';
import AttachmentSidebar from './AttachmentSidebar';
import ChatSidebar from '../../components/editor/ChatSidebar';
import NotebookSelector from '../../components/editor/NotebookSelector';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { useNoteController } from './useNoteController';
import { useQueryClient } from '@tanstack/react-query';

interface NoteEditorProps {
    note: Note;
    onBack?: () => void;
}

export default function NoteEditor({ note, onBack }: NoteEditorProps) {
    const { t } = useTranslation();
    const { user } = useAuthStore();
    const queryClient = useQueryClient();
    const { notebooks } = useNotebooks();

    // -- Controller --
    const { updateTitle, updateContent, saveNote } = useNoteController(note);

    // -- Local State for Inputs --
    const [titleInput, setTitleInput] = useState(note.title);
    const [contentInput, setContentInput] = useState(note.content);

    const titleRef = useRef<HTMLInputElement>(null);

    // -- Debounce for saving --
    // We update Dexie after 300ms of inactivity. 
    // Dexie update will trigger a SyncQueue item.
    const debouncedTitle = useDebounce(titleInput, 300);
    const debouncedContent = useDebounce(contentInput, 1000); // Content can be slower

    // -- UI State --
    const [isSharingModalOpen, setIsSharingModalOpen] = useState(false);
    const [isVaultConfirmOpen, setIsVaultConfirmOpen] = useState(false);
    const [isAttachmentSidebarOpen, setIsAttachmentSidebarOpen] = useState(false);
    const [isChatOpen, setIsChatOpen] = useState(false);
    const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
    const [isDragging, setIsDragging] = useState(false);

    const [provider, setProvider] = useState<HocuspocusProvider | null>(null);
    const [collaborators, setCollaborators] = useState<any[]>([]);
    const [unreadCount, setUnreadCount] = useState(0);
    const isChatOpenRef = useRef(isChatOpen);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // -- Sync from Prop to State (Guarded) --
    useEffect(() => {
        // If we are editing, DO NOT overwrite local state with props.
        if (document.activeElement === titleRef.current) return;

        // If the prop changed externally (Sync), update local state
        if (note.title !== titleInput) {
            setTitleInput(note.title);
        }
    }, [note.title]); // We don't depend on titleInput here to avoid loops

    useEffect(() => {
        // Content sync is trickier because Editor manages focus.
        // Usually Editor component handles prop updates internally.
        // We just update our local input tracker if needed? 
        // Actually, we pass contentInput to Editor. Editor should update validation.
        if (note.content !== contentInput) {
            // We need to be careful not to reset cursor in Tiptap.
            // Ideally Editor component handles 'content' prop changes gracefully.
            setContentInput(note.content);
        }
    }, [note.content]);

    // -- Save Effects --
    useEffect(() => {
        if (note.isTrashed) return; // Don't save if trashed (prevents resurrection race)
        if (debouncedTitle !== note.title) {
            updateTitle(debouncedTitle);
        }
    }, [debouncedTitle, note.id, note.isTrashed]); // note.id check ensures we don't save to wrong note if switched fast

    useEffect(() => {
        if (note.isTrashed) return; // Don't save if trashed

        if (debouncedContent !== note.content) {
            if (provider) {
                // If Hocuspocus is active, we update Local DB ONLY (for UI preview),
                // and rely on Hocuspocus for Server Sync.
                // We SKIP the standard updateContent which triggers REST Sync Push.
                import('./noteService').then(service => {
                    service.updateNoteLocalOnly(note.id, { content: debouncedContent });
                });
            } else {
                updateContent(debouncedContent);
            }
        }
    }, [debouncedContent, note.id, provider, note.isTrashed, updateContent]);


    // -- Hocuspocus / Chat Logic --
    useEffect(() => {
        if (isChatOpen) setUnreadCount(0);
    }, [isChatOpen]);

    useEffect(() => {
        if (note.id) {
            const newProvider = new HocuspocusProvider({
                url: import.meta.env.VITE_WS_URL || 'ws://localhost:3001/ws',
                name: note.id,
                token: useAuthStore.getState().token || '',
                onSynced: () => {
                    // Sync handled by provider
                },
            });
            setProvider(newProvider);
            return () => newProvider.destroy();
        }
    }, [note.id]);

    useEffect(() => {
        if (!provider) return;
        const updateCollaborators = () => {
            const states = provider.awareness?.getStates();
            if (states) {
                const activeUsers = Array.from(states.values()).map((s: any) => s.user).filter((u: any) => u && u.name);
                setCollaborators(activeUsers);
            }
        };
        provider.on('awarenessUpdate', updateCollaborators);
        updateCollaborators();

        return () => {
            provider.off('awarenessUpdate', updateCollaborators);
        };
    }, [provider]);

    // -- Handlers --

    const handlePinToggle = () => {
        saveNote({ isPinned: !note.isPinned });
        toast.success(!note.isPinned ? t('notes.pinned') : t('notes.unpinned'));
    };

    const handleVaultToggle = () => {
        saveNote({ isVault: !note.isVault });
        toast.success(!note.isVault ? t('notes.addedToVault') : t('notes.removedFromVault'));
    };

    const handleVaultConfirm = async () => {
        try {
            // Logic moved inline, but ideally controller would handle this. 
            // For now, manual update is fine.
            const updates: Partial<Note> = { isVault: true };
            if (note.isPublic) updates.isPublic = false;

            // Revoke shares (side effect)
            if (note.sharedWith?.length) {
                for (const share of note.sharedWith) {
                    await revokeShare(note.id, share.userId);
                }
            }

            await saveNote(updates);

            toast.success(t('notes.addedToVault'));
            setIsVaultConfirmOpen(false);
        } catch (error) {
            console.error(error);
            toast.error(t('notes.saveFailed'));
        }
    };

    // Attachments
    const handleDrop = async (e: React.DragEvent) => {
        e.preventDefault(); setIsDragging(false);
        const files = Array.from(e.dataTransfer.files);
        for (const file of files) {
            try {
                await uploadAttachment(note.id, file);
                toast.success(t('notes.uploaded', { name: file.name }));
            } catch (error) {
                toast.error(t('notes.uploadFailed', { name: file.name }));
            }
        }
    };

    // Misc
    const userColor = useMemo(() => '#' + Math.floor(Math.random() * 16777215).toString(16), []);
    const collaborationConfig = useMemo(() => ({
        enabled: !!provider,
        documentId: note.id,
        token: useAuthStore.getState().token || '',
        user: { name: user?.name || 'User', color: userColor }
    }), [provider, note.id, user, userColor]);


    // Focus Handler
    const editorRef = useRef<any>(null);

    const handleTitleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Tab') {
            e.preventDefault();
            // Focus the editor
            if (editorRef.current) {
                editorRef.current.focus();
            }
        }
    };

    return (
        <div
            className="flex flex-col h-full bg-white dark:bg-gray-900 relative"
            onDrop={handleDrop}
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }}
        >
            {/* Header */}
            <header className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 z-10">
                <div className="flex items-center gap-3 flex-1">
                    {onBack && (
                        <button onClick={onBack} className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors">
                            <ArrowLeft className="w-5 h-5 text-gray-600 dark:text-gray-400" />
                        </button>
                    )}
                    <input
                        ref={titleRef}
                        type="text"
                        value={titleInput}
                        onChange={(e) => setTitleInput(e.target.value)}
                        onKeyDown={handleTitleKeyDown}
                        placeholder={t('notes.titlePlaceholder')}
                        className="text-xl font-semibold bg-transparent border-none focus:outline-none text-gray-900 dark:text-white flex-1"
                    />
                </div>

                <div className="flex items-center gap-2">
                    {/* Collaborators UI */}
                    <div className="flex items-center -space-x-2 mr-4">
                        {collaborators.map((c, i) => (
                            <div key={i} className="w-8 h-8 rounded-full border-2 border-white dark:border-gray-900 flex items-center justify-center text-xs font-medium text-white shadow-sm" style={{ backgroundColor: c.color }} title={c.name}>
                                {c.name.charAt(0).toUpperCase()}
                            </div>
                        ))}
                        {collaborators.length === 0 && provider && (
                            <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center text-xs text-gray-500"><Users className="w-4 h-4" /></div>
                        )}
                    </div>

                    <div className="hidden md:flex items-center gap-2">
                        <NotebookSelector
                            notebooks={notebooks || []}
                            selectedNotebookId={note.notebookId}
                            onSelect={(notebookId) => saveNote({ notebookId })}
                        />
                        <TagSelector
                            noteId={note.id}
                            noteTags={note.tags || []}
                            onUpdate={() => queryClient.invalidateQueries({ queryKey: ['notes'] })}
                            isVault={note.isVault}
                        />
                    </div>

                    <div className="h-6 w-px bg-gray-200 dark:bg-gray-700 mx-2" />

                    {/* Actions */}
                    {/* Only show chat if there are active collaborators OR (there are accepted shared users) */}
                    {(collaborators.length > 1 || (note.sharedWith?.some(s => s.status === 'ACCEPTED'))) && (
                        <button onClick={() => setIsChatOpen(!isChatOpen)} className={clsx("p-2 rounded-full transition-colors relative", isChatOpen ? "bg-emerald-100 text-emerald-600" : "hover:bg-gray-100 dark:hover:bg-gray-800")}>
                            <MessageSquare className="w-5 h-5" />
                            {unreadCount > 0 && <span className="absolute top-0 right-0 -mt-1 -mr-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] text-white ring-2 ring-white">{unreadCount > 9 ? '9+' : unreadCount}</span>}
                        </button>
                    )}

                    {!note.isVault && (
                        /* Only show 'Shared' indicator (e.g. could change icon or something) if accepted? 
                           The current icon is just a Share button that opens the modal. 
                           The *badge* mentioned in request: "sharing badge in User 1's app". 
                           Currently we don't have a distinct "Shared Badge" in this header, just the share button.
                           Ah, maybe the user meant the "Shared with Me" badge in list? 
                           Or maybe they want a visual indicator here?
                           The prompt said: "The note sharing (and the sharing badge in User 1's app) must only become active if at least one invited user accepts".
                           
                           If "sharing badge" means the Chat button? Or maybe a "Shared" label?
                           In the notes list (SharedWithMePage), we have indicators.
                           But in the Editor? 
                           
                           Let's assume "active" means the functionality is considered "Shared".
                           For the Share Button itself, it's always active to allow inviting more people.
                           
                           The User said: "sharing badge... must only become active".
                           If there is no badge, maybe I should add one? 
                           Or maybe they rely on the Chat button appearing?
                           Or maybe in the `NotesPage` list view?
                           
                           Let's assume the "Chat Button" appearing is the main active state change here.
                           AND if there is a "Shared" icon/badge in the list view.
                           I will verify `NotesPage` (list) logic too.
                           
                           For now, updating Chat Button visibility condition.
                        */
                        <button onClick={() => setIsSharingModalOpen(true)} className={clsx("p-2 rounded-full transition-colors", (note.sharedWith?.some(s => s.status === 'ACCEPTED')) ? "text-emerald-600 bg-emerald-50" : "hover:bg-gray-100 dark:hover:bg-gray-800")}><Share2 className="w-5 h-5" /></button>
                    )}
                    <button onClick={() => setIsAttachmentSidebarOpen(!isAttachmentSidebarOpen)} className={clsx("p-2 rounded-full transition-colors", isAttachmentSidebarOpen ? "bg-emerald-100 text-emerald-600" : "hover:bg-gray-100 dark:hover:bg-gray-800")}><Paperclip className="w-5 h-5" /></button>

                    <button onClick={handlePinToggle} className={clsx("p-2 rounded-full transition-colors", note.isPinned ? "text-amber-500 bg-amber-50 dark:bg-amber-900/20" : "text-gray-400 hover:text-amber-500 hover:bg-amber-50")}><Star className={clsx("w-5 h-5", note.isPinned && "fill-current")} /></button>

                    <button onClick={() => { if (!note.isVault && (note.isPublic || (note.sharedWith && note.sharedWith.length > 0))) setIsVaultConfirmOpen(true); else handleVaultToggle(); }} className={clsx("p-2 rounded-full transition-colors", note.isVault ? "text-emerald-500 bg-emerald-50 dark:bg-emerald-900/20" : "text-gray-400 hover:text-emerald-500 hover:bg-emerald-50")}><Lock className={clsx("w-5 h-5", note.isVault && "fill-current")} /></button>

                    <button onClick={() => setIsDeleteConfirmOpen(true)} className="p-2 hover:bg-red-50 text-gray-400 hover:text-red-500 rounded-full transition-colors"><Trash2 className="w-5 h-5" /></button>
                </div>
            </header>

            {/* Editor */}
            <div className="flex-1 overflow-y-auto relative">
                <Editor
                    ref={editorRef}
                    content={contentInput}
                    onChange={setContentInput}
                    provider={provider}
                    collaboration={collaborationConfig}
                />
                <ChatSidebar
                    key={note.id}
                    noteId={note.id}
                    isOpen={isChatOpen}
                    onClose={() => setIsChatOpen(false)}
                    currentUser={{ id: user?.id || 'anon', name: user?.name || 'User', color: userColor }}
                    onNewMessage={() => setUnreadCount(prev => prev + 1)}
                />
            </div>

            {/* Overlays */}
            {isDragging && <div className="absolute inset-0 flex items-center justify-center bg-white/80 pointer-events-none z-50 dark:bg-gray-900/80"><div className="text-2xl font-bold text-emerald-600">{t('notes.dropFiles')}</div></div>}

            <input type="file" ref={fileInputRef} className="hidden" multiple onChange={(e) => { const files = e.target.files; if (files) Array.from(files).forEach(f => uploadAttachment(note.id, f).then(() => toast.success(t('notes.uploaded', { name: f.name }))).catch(() => toast.error(t('notes.uploadFailed', { name: f.name })))) }} />

            <SharingModal isOpen={isSharingModalOpen} onClose={() => setIsSharingModalOpen(false)} noteId={note.id} sharedWith={note.sharedWith?.map(s => ({ id: s.userId, name: s.user.name, email: s.user.email, permission: s.permission }))} />

            <ConfirmDialog isOpen={isVaultConfirmOpen} onClose={() => setIsVaultConfirmOpen(false)} onConfirm={handleVaultConfirm} title={t('vault.warningTitle')} message={t('notes.vaultWarningMessage')} confirmText={t('common.confirm')} variant="danger" />

            <ConfirmDialog isOpen={isDeleteConfirmOpen} onClose={() => setIsDeleteConfirmOpen(false)} onConfirm={async () => { await saveNote({ title: titleInput, content: contentInput }); await import('./noteService').then(m => m.deleteNote(note.id)); toast.success(t('notes.deleted')); onBack ? onBack() : window.history.back(); }} title={t('notes.moveToTrash')} message={t('notes.moveToTrashConfirm')} confirmText={t('notes.moveToTrashAction')} variant="danger" />

            {isAttachmentSidebarOpen && <AttachmentSidebar attachments={note.attachments || []} onClose={() => setIsAttachmentSidebarOpen(false)} onDelete={deleteAttachment.bind(null, note.id)} onAdd={() => fileInputRef.current?.click()} />}
        </div>
    );
}
