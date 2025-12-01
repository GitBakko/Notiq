import { useState, useEffect, useRef, useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCircle, Circle, Share2, Copy, ExternalLink, ArrowLeft, Star, Trash2, Globe, MessageSquare, Paperclip, Users } from 'lucide-react';
import Editor from '../../components/editor/Editor';
import { updateNote, toggleShare, deleteNote, type Note } from './noteService';
import { useDebounce } from '../../hooks/useDebounce';
import { uploadAttachment, deleteAttachment } from '../attachments/attachmentService';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { useIsMobile } from '../../hooks/useIsMobile';
import TagSelector from '../../components/editor/TagSelector';
import { useNotebooks } from '../../hooks/useNotebooks';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../../store/authStore';

import SharingModal from '../../components/sharing/SharingModal';
import AttachmentSidebar from './AttachmentSidebar';
import ChatSidebar from '../../components/editor/ChatSidebar';
import DatePicker from '../../components/ui/DatePicker';
import NotebookSelector from '../../components/editor/NotebookSelector';
import { HocuspocusProvider } from '@hocuspocus/provider';
import AudioRecorder from '../../components/editor/AudioRecorder';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';

interface NoteEditorProps {
    note: Note;
    onBack?: () => void;
}

export default function NoteEditor({ note, onBack }: NoteEditorProps) {
    const { t } = useTranslation();
    const { user } = useAuthStore();
    const isMobile = useIsMobile();
    const queryClient = useQueryClient();
    const { notebooks } = useNotebooks();

    const isOwner = user?.id === note.userId;
    console.log('NoteEditor: isOwner check', { userId: user?.id, noteUserId: note.userId, isOwner });

    const [editorContent, setEditorContent] = useState(note.content);
    const [title, setTitle] = useState(note.title);
    const [reminderDate, setReminderDate] = useState<string>(note.reminderDate ? new Date(note.reminderDate).toISOString().slice(0, 16) : '');
    const [isReminderDone, setIsReminderDone] = useState<boolean>(note.isReminderDone || false);
    const [isPublic, setIsPublic] = useState(note.isPublic);
    const [shareId, setShareId] = useState(note.shareId);
    const [isDragging, setIsDragging] = useState(false);
    const [isSharingModalOpen, setIsSharingModalOpen] = useState(false);
    const [isAttachmentSidebarOpen, setIsAttachmentSidebarOpen] = useState(false);
    const [showAudioRecorder, setShowAudioRecorder] = useState(false);
    const [isChatOpen, setIsChatOpen] = useState(false);
    const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
    const [provider, setProvider] = useState<HocuspocusProvider | null>(null);
    const [collaborators, setCollaborators] = useState<any[]>([]);

    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (note.id) {
            const newProvider = new HocuspocusProvider({
                url: 'ws://localhost:1234',
                name: note.id,
                token: useAuthStore.getState().token || '',
            });
            setProvider(newProvider);

            return () => {
                newProvider.destroy();
            };
        }
    }, [note.id]);

    useEffect(() => {
        if (provider) {
            const updateCollaborators = () => {
                const states = provider.awareness?.getStates();
                if (states) {
                    const activeUsers = Array.from(states.values())
                        .map((state: any) => state.user)
                        .filter((u: any) => u && u.name);

                    setCollaborators(activeUsers);
                }
            };

            provider.on('awarenessUpdate', updateCollaborators);
            // Initial check
            updateCollaborators();

            return () => {
                provider.off('awarenessUpdate', updateCollaborators);
            };
        }
    }, [provider]);

    const updateMutation = useMutation({
        mutationFn: ({ id, data }: { id: string; data: Partial<Note> }) => updateNote(id, data),
        onSuccess: (data) => {
            console.log('NoteEditor: updateMutation success', data);
            queryClient.invalidateQueries({ queryKey: ['notes'] });
        },
        onError: (err) => {
            console.error('NoteEditor: updateMutation error', err);
            toast.error(t('notes.saveFailed'));
        }
    });

    const debouncedContent = useDebounce(editorContent, 1000);
    const debouncedTitle = useDebounce(title, 1000);

    // Sync local state when note changes
    useEffect(() => {
        setEditorContent(note.content);
        setTitle(note.title);
        setReminderDate(note.reminderDate ? new Date(note.reminderDate).toISOString().slice(0, 16) : '');
        setIsReminderDone(note.isReminderDone || false);
        setIsPublic(note.isPublic);
        setShareId(note.shareId);
    }, [note.id, note.isPublic, note.shareId, note.content]);

    useEffect(() => {
        // If using collaboration, don't save content via REST to avoid conflicts
        if (provider) return;

        if (debouncedContent !== note.content) {
            updateMutation.mutate({ id: note.id, data: { content: debouncedContent } });
        }
    }, [debouncedContent, note.id, provider]);

    useEffect(() => {
        if (debouncedTitle !== note.title) {
            updateMutation.mutate({ id: note.id, data: { title: debouncedTitle } });
        }
    }, [debouncedTitle, note.id]);

    const handleReminderDoneToggle = () => {
        const newValue = !isReminderDone;
        setIsReminderDone(newValue);
        updateMutation.mutate({ id: note.id, data: { isReminderDone: newValue } });
    };

    const handleReminderChange = (date: Date | undefined) => {
        if (!date) {
            setReminderDate('');
            updateMutation.mutate({ id: note.id, data: { reminderDate: null } });
            return;
        }

        const newDate = new Date(date);
        if (reminderDate) {
            const oldDate = new Date(reminderDate);
            newDate.setHours(oldDate.getHours(), oldDate.getMinutes());
        } else {
            newDate.setHours(9, 0, 0, 0); // Default 9 AM
        }

        const iso = newDate.toISOString();
        setReminderDate(iso);
        updateMutation.mutate({ id: note.id, data: { reminderDate: iso } });
    };

    const handleTimeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const time = e.target.value;
        if (!reminderDate || !time) return;

        const [hours, minutes] = time.split(':').map(Number);
        const newDate = new Date(reminderDate);
        newDate.setHours(hours, minutes);

        const iso = newDate.toISOString();
        setReminderDate(iso);
        updateMutation.mutate({ id: note.id, data: { reminderDate: iso } });
    };

    const handlePinToggle = () => {
        const newValue = !note.isPinned;
        updateMutation.mutate({ id: note.id, data: { isPinned: newValue } });
        toast.success(newValue ? t('notes.pinned') : t('notes.unpinned'));
    };

    const shareMutation = useMutation({
        mutationFn: toggleShare,
        onMutate: () => {
            // Optimistic update
            setIsPublic(!isPublic);
        },
        onSuccess: (data) => {
            queryClient.invalidateQueries({ queryKey: ['notes'] });
            // Ensure state matches server response
            setIsPublic(data.isPublic);
            setShareId(data.shareId);

            if (data.isPublic) {
                toast.success(t('notes.nowPublic'), {
                    style: {
                        background: '#10b981',
                        color: '#fff',
                    },
                    icon: '🌍'
                });
            } else {
                toast.success(t('notes.nowPrivate'), {
                    style: {
                        background: '#6b7280',
                        color: '#fff',
                    },
                    icon: '🔒'
                });
            }
        },
        onError: () => {
            // Revert on error
            setIsPublic(!isPublic);
            toast.error(t('notes.sharingFailed'));
        }
    });

    const copyShareLink = () => {
        if (shareId) {
            const url = `${window.location.origin}/public/notes/${shareId}`;
            navigator.clipboard.writeText(url);
            toast.success(t('notes.linkCopied'));
        }
    };

    const handleDrop = async (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);

        const files = Array.from(e.dataTransfer.files);
        if (files.length === 0) return;

        for (const file of files) {
            try {
                await uploadAttachment(note.id, file);
                toast.success(t('notes.uploaded', { name: file.name }));
            } catch (error) {
                console.error('Failed to upload', file.name, error);
                toast.error(t('notes.uploadFailed', { name: file.name }));
            }
        }
    };

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(true);
    };

    const handleDragLeave = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
    };

    const handleDeleteAttachment = async (attachmentId: string) => {
        try {
            await deleteAttachment(note.id, attachmentId);
            toast.success(t('notes.attachmentDeleted'));
        } catch (error) {
            console.error('Failed to delete attachment', error);
            toast.error(t('notes.deleteAttachmentFailed'));
        }
    };

    const handleAttachClick = () => {
        fileInputRef.current?.click();
    };

    const handleVoiceMemo = () => {
        setShowAudioRecorder(true);
    };

    const saveVoiceMemo = async (blob: Blob) => {
        const file = new File([blob], `voice-memo-${Date.now()}.webm`, { type: 'audio/webm' });
        try {
            await uploadAttachment(note.id, file);
            setShowAudioRecorder(false);
            toast.success(t('notes.attachmentUploaded'));
        } catch (error) {
            console.error('Failed to upload voice memo:', error);
            toast.error(t('notes.uploadFailed'));
        }
    };

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;

        for (const file of Array.from(files)) {
            try {
                await uploadAttachment(note.id, file);
                toast.success(t('notes.uploaded', { name: file.name }));
            } catch (error) {
                console.error('Failed to upload', file.name, error);
                toast.error(t('notes.uploadFailed', { name: file.name }));
            }
        }
    };

    if (!note) return null;

    const userColor = useMemo(() => {
        return '#' + Math.floor(Math.random() * 16777215).toString(16);
    }, []);

    const collaborationConfig = useMemo(() => ({
        enabled: !!provider,
        documentId: note.id,
        token: useAuthStore.getState().token || '',
        user: {
            name: user?.name || 'User',
            color: userColor,
        }
    }), [provider, note.id, user?.name, userColor]);

    return (
        <div
            className="flex flex-col h-full bg-white dark:bg-gray-900 relative"
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
        >
            {/* Header */}
            <header className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 z-10">
                <div className="flex items-center gap-3 flex-1">
                    {onBack && (
                        <button
                            onClick={onBack}
                            className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors"
                        >
                            <ArrowLeft className="w-5 h-5 text-gray-600 dark:text-gray-400" />
                        </button>
                    )}
                    <input
                        type="text"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        onBlur={() => {
                            if (title !== note.title) {
                                updateMutation.mutate({ id: note.id, data: { title } });
                            }
                        }}
                        placeholder={t('notes.titlePlaceholder')}
                        className="text-xl font-semibold bg-transparent border-none focus:outline-none text-gray-900 dark:text-white flex-1"
                    />
                </div>

                <div className="flex items-center gap-2">
                    {/* Collaborators */}
                    <div className="flex items-center -space-x-2 mr-4">
                        {collaborators.map((collabUser, index) => (
                            <div
                                key={index}
                                className="w-8 h-8 rounded-full border-2 border-white dark:border-gray-900 flex items-center justify-center text-xs font-medium text-white shadow-sm"
                                style={{ backgroundColor: collabUser.color }}
                                title={collabUser.name}
                            >
                                {collabUser.name.charAt(0).toUpperCase()}
                            </div>
                        ))}
                        {collaborators.length === 0 && provider && (
                            <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center text-xs text-gray-500">
                                <Users className="w-4 h-4" />
                            </div>
                        )}
                    </div>

                    <div className="hidden md:flex items-center gap-2">
                        <NotebookSelector
                            notebooks={notebooks}
                            selectedNotebookId={note.notebookId}
                            onSelect={(notebookId) => updateMutation.mutate({ id: note.id, data: { notebookId } })}
                        />
                        <TagSelector
                            selectedTags={note.tags}
                            onChange={(tags) => updateMutation.mutate({ id: note.id, data: { tags } })}
                        />
                    </div>

                    <div className="h-6 w-px bg-gray-200 dark:bg-gray-700 mx-2" />

                    <button
                        onClick={() => setIsChatOpen(!isChatOpen)}
                        className={clsx(
                            "p-2 rounded-full transition-colors relative",
                            isChatOpen ? "bg-emerald-100 text-emerald-600" : "hover:bg-gray-100 text-gray-600 dark:text-gray-400 dark:hover:bg-gray-800"
                        )}
                        title={t('notes.chat')}
                    >
                        <MessageSquare className="w-5 h-5" />
                    </button>

                    <button
                        onClick={() => setIsSharingModalOpen(true)}
                        className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors text-gray-600 dark:text-gray-400"
                        title={t('notes.share')}
                    >
                        <Share2 className="w-5 h-5" />
                    </button>

                    <button
                        onClick={() => setIsAttachmentSidebarOpen(!isAttachmentSidebarOpen)}
                        className={clsx(
                            "p-2 rounded-full transition-colors",
                            isAttachmentSidebarOpen ? "bg-emerald-100 text-emerald-600" : "hover:bg-gray-100 text-gray-600 dark:text-gray-400 dark:hover:bg-gray-800"
                        )}
                        title={t('notes.attachments')}
                    >
                        <Paperclip className="w-5 h-5" />
                    </button>

                    <button
                        onClick={handlePinToggle}
                        className={clsx(
                            "p-2 rounded-full transition-colors",
                            note.isPinned ? "text-amber-500 bg-amber-50 dark:bg-amber-900/20" : "text-gray-400 hover:text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-900/20"
                        )}
                        title={note.isPinned ? t('notes.unpin') : t('notes.pin')}
                    >
                        <Star className={clsx("w-5 h-5", note.isPinned && "fill-current")} />
                    </button>

                    <button
                        onClick={() => setIsDeleteConfirmOpen(true)}
                        className="p-2 hover:bg-red-50 text-gray-400 hover:text-red-500 rounded-full transition-colors dark:hover:bg-red-900/20"
                        title={t('common.delete')}
                    >
                        <Trash2 className="w-5 h-5" />
                    </button>
                </div>
            </header>

            {/* Editor Area */}
            <div className="flex-1 overflow-y-auto relative">
                <Editor
                    content={editorContent}
                    onChange={setEditorContent}
                    onVoiceMemo={handleVoiceMemo}
                    provider={provider}
                    collaboration={collaborationConfig}
                />

                <ChatSidebar
                    provider={provider}
                    isOpen={isChatOpen}
                    onClose={() => setIsChatOpen(false)}
                    currentUser={{
                        id: user?.id || 'anon',
                        name: user?.name || 'User',
                        color: '#' + Math.floor(Math.random() * 16777215).toString(16),
                    }}
                />
            </div>

            {isDragging && (
                <div className="absolute inset-0 flex items-center justify-center bg-white/80 pointer-events-none z-50 dark:bg-gray-900/80">
                    <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-500">{t('notes.dropFiles')}</div>
                </div>
            )}

            {/* Hidden File Input */}
            <input
                type="file"
                ref={fileInputRef}
                className="hidden"
                multiple
                onChange={handleFileChange}
            />

            <SharingModal
                isOpen={isSharingModalOpen}
                onClose={() => setIsSharingModalOpen(false)}
                noteId={note.id}
                sharedWith={note.sharedWith?.map(s => ({
                    id: s.userId,
                    name: s.user.name,
                    email: s.user.email,
                    permission: s.permission
                }))}
            />

            <ConfirmDialog
                isOpen={isDeleteConfirmOpen}
                onClose={() => setIsDeleteConfirmOpen(false)}
                onConfirm={async () => {
                    await deleteNote(note.id);
                    toast.success(t('notes.deleted'));
                    onBack ? onBack() : window.history.back();
                }}
                title={t('notes.deleteConfirmTitle', 'Delete Note')}
                message={t('notes.deleteConfirm', 'Are you sure you want to delete this note?')}
                confirmText={t('common.delete')}
                variant="danger"
            />

            {isAttachmentSidebarOpen && (
                <AttachmentSidebar
                    attachments={note.attachments || []}
                    onClose={() => setIsAttachmentSidebarOpen(false)}
                    onDelete={handleDeleteAttachment}
                    onAdd={handleAttachClick}
                />
            )}
        </div>
    );
}
