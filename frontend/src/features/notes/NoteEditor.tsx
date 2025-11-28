import { useState, useEffect, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCircle, Circle, Share2, Copy, ExternalLink, ArrowLeft, Star, Trash2, Globe, MessageSquare, Paperclip } from 'lucide-react';
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
    const [provider, setProvider] = useState<HocuspocusProvider | null>(null);

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
        if (debouncedContent !== note.content) {
            updateMutation.mutate({ id: note.id, data: { content: debouncedContent } });
        }
    }, [debouncedContent, note.id]);

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

    return (
            <div
                className="flex flex-col h-full bg-white dark:bg-gray-900 relative"
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
            >
                {/* Audio Recorder Modal */}
                {showAudioRecorder && (
                    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
                        <div className="bg-white dark:bg-gray-800 p-1 rounded-lg shadow-xl">
                            <AudioRecorder
                                onSave={saveVoiceMemo}
                                onCancel={() => setShowAudioRecorder(false)}
                            />
                        </div>
                    </div>
                )}

                {/* Toolbar */}
                <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-800">
                    <div className="flex items-center gap-3 flex-1">
                        {isMobile && onBack && (
                            <button onClick={onBack} className="md:hidden text-gray-500 dark:text-gray-400">
                                <ArrowLeft size={20} />
                            </button>
                        )}
                        <input
                            type="text"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            placeholder={t('notes.titlePlaceholder')}
                            className="text-xl font-bold bg-transparent border-none focus:ring-0 p-0 w-full text-gray-900 dark:text-white placeholder-gray-400"
                        />
                    </div>
                    <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-400 dark:text-gray-500 hidden sm:inline">
                            {updateMutation.isPending ? t('common.saving') : t('common.saved')}
                        </span>

                        <button
                            onClick={() => setIsChatOpen(!isChatOpen)}
                            className={clsx(
                                "p-2 rounded-full hover:bg-gray-100 transition-colors dark:hover:bg-gray-800 relative",
                                isChatOpen ? "text-emerald-600 dark:text-emerald-500" : "text-gray-500 dark:text-gray-400"
                            )}
                            title={t('chat.title', 'Chat')}
                        >
                            <MessageSquare size={20} />
                        </button>

                        {isOwner && (
                            <button
                                onClick={() => setIsSharingModalOpen(true)}
                                className="p-2 rounded-full hover:bg-gray-100 transition-colors dark:hover:bg-gray-800 text-gray-500 dark:text-gray-400"
                                title={t('sharing.title')}
                            >
                                <Share2 size={20} />
                            </button>
                        )}

                        <button
                            onClick={handlePinToggle}
                            className={clsx(
                                "p-2 rounded-full hover:bg-gray-100 transition-colors dark:hover:bg-gray-800",
                                note.isPinned ? "text-emerald-600 dark:text-emerald-500" : "text-gray-400 dark:text-gray-500"
                            )}
                            title={note.isPinned ? t('notes.unpin') : t('notes.pin')}
                        >
                            <Star size={20} fill={note.isPinned ? "currentColor" : "none"} />
                        </button>

                        <button
                            onClick={() => setIsAttachmentSidebarOpen(!isAttachmentSidebarOpen)}
                            className={clsx(
                                "p-2 rounded-full hover:bg-gray-100 transition-colors dark:hover:bg-gray-800 relative",
                                (note.attachments?.length || 0) > 0 ? "text-emerald-600 dark:text-emerald-500" : "text-gray-400 dark:text-gray-500"
                            )}
                            title={t('notes.attachments')}
                        >
                            <Paperclip size={20} />
                            {(note.attachments?.length || 0) > 0 && (
                                <span className="absolute -top-1 -right-1 bg-emerald-600 text-white text-[10px] font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">
                                    {note.attachments!.length}
                                </span>
                            )}
                        </button>

                        <button
                            onClick={async () => {
                                if (confirm(t('notes.deleteConfirm'))) {
                                    await deleteNote(note.id);
                                    toast.success(t('notes.deleted'));
                                    onBack ? onBack() : window.history.back();
                                }
                            }}
                            className="p-2 rounded-full hover:bg-gray-100 transition-colors dark:hover:bg-gray-800 text-gray-500 dark:text-gray-400 hover:text-red-600 dark:hover:text-red-500"
                            title={t('common.delete')}
                        >
                            <Trash2 size={20} />
                        </button>
                    </div>
                </div>

                {/* Meta bar */}
                <div className="flex items-center px-4 py-2 border-b border-gray-200 bg-gray-50 text-xs text-gray-500 dark:bg-gray-900 dark:border-gray-800 dark:text-gray-400 overflow-x-auto">
                    <div className="flex items-center gap-2 min-w-max">
                        <NotebookSelector
                            notebooks={notebooks || []}
                            selectedNotebookId={note.notebookId}
                            onSelect={(id) => {
                                updateMutation.mutate({ id: note.id, data: { notebookId: id } });
                            }}
                        />
                    </div>
                    <span className="border-l pl-2 border-gray-200 ml-2 dark:border-gray-700">{t('common.lastEdited')} {note.updatedAt ? new Date(note.updatedAt).toLocaleString() : ''}</span>

                    <div className="flex items-center gap-2 ml-4 border-l pl-4 border-gray-200 dark:border-gray-700">
                        <Bell size={14} className={reminderDate ? "text-emerald-600 dark:text-emerald-500" : "text-gray-400 dark:text-gray-500"} />
                        <DatePicker
                            date={reminderDate ? new Date(reminderDate) : undefined}
                            onSelect={handleReminderChange}
                            placeholder={t('notes.addReminder')}
                            className="text-xs"
                            disabled={{ before: new Date() }}
                        />
                        {reminderDate && (
                            <input
                                type="time"
                                value={new Date(reminderDate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
                                onChange={handleTimeChange}
                                className="bg-transparent border-none text-xs text-gray-600 focus:ring-0 p-0 w-16 dark:text-gray-300 dark:[color-scheme:dark]"
                            />
                        )}
                        {reminderDate && (
                            <button onClick={handleReminderDoneToggle} className="ml-1 hover:text-emerald-600 transition-colors dark:hover:text-emerald-400" title={t('notes.markReminderDone')}>
                                {isReminderDone ? <CheckCircle size={14} className="text-emerald-600 dark:text-emerald-500" /> : <Circle size={14} />}
                            </button>
                        )}
                    </div>

                    <div className="flex items-center gap-2 ml-4 border-l pl-4 border-gray-200 dark:border-gray-700">
                        {isOwner && (
                            <button
                                onClick={() => shareMutation.mutate(note.id)}
                                disabled={shareMutation.isPending}
                                className={clsx(
                                    "flex items-center gap-1 transition-colors",
                                    isPublic ? "text-emerald-600 dark:text-emerald-500 hover:text-emerald-700 dark:hover:text-emerald-400" : "text-gray-400 dark:text-gray-500 hover:text-emerald-600 dark:hover:text-emerald-400",
                                    shareMutation.isPending && "opacity-50 cursor-not-allowed"
                                )}
                                title={isPublic ? t('notes.makePrivate') : t('notes.makePublic')}
                            >
                                <Globe size={14} />
                                <span className="hidden sm:inline">{isPublic ? t('notes.public') : t('notes.private')}</span>
                            </button>
                        )}

                        {isPublic && (
                            <>
                                <button onClick={copyShareLink} className="text-gray-400 hover:text-emerald-600 dark:text-gray-500 dark:hover:text-emerald-400" title={t('notes.copyLink')}>
                                    <Copy size={14} />
                                </button>
                                <a
                                    href={`/public/notes/${shareId}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-gray-400 hover:text-emerald-600 dark:text-gray-500 dark:hover:text-emerald-400"
                                    title={t('notes.openLink')}
                                >
                                    <ExternalLink size={14} />
                                </a>
                            </>
                        )}
                    </div>

                    <div className="flex gap-1 ml-2 border-l pl-4 border-gray-200 dark:border-gray-700">
                        <TagSelector
                            noteId={note.id}
                            noteTags={note.tags || []}
                            onUpdate={() => {
                                queryClient.invalidateQueries({ queryKey: ['notes'] });
                            }}
                        />
                    </div>
                </div>

                {/* Editor Area */}
                <div className="flex-1 overflow-y-auto relative">
                    <Editor
                        content={editorContent}
                        onChange={setEditorContent}
                        onAttach={() => setIsAttachmentSidebarOpen(true)}
                        onVoiceMemo={handleVoiceMemo}
                        provider={provider}
                        collaboration={{
                            enabled: !!provider,
                            documentId: note.id,
                            token: useAuthStore.getState().token || '',
                            user: {
                                name: user?.name || 'User',
                                color: '#' + Math.floor(Math.random() * 16777215).toString(16),
                            }
                        }}
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
