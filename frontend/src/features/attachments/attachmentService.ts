import api from '../../lib/api';
import { db } from '../../lib/db';
import queryClient from '../../lib/queryClient';
import { queryKeys } from '../../lib/queryKeys';
import type { Note } from '../notes/noteService';

export const uploadAttachment = async (noteId: string, file: File) => {
  const formData = new FormData();
  formData.append('file', file);

  // For MVP, we upload directly to backend even if offline-first?
  // Or we store in IndexedDB as Blob?
  // Storing large blobs in IndexedDB can be heavy.
  // Let's try to upload immediately if online.
  // If offline, we could queue it, but handling file uploads in sync queue is complex.
  // Let's assume online-only for attachments for now, or simple retry.
  
  try {
      const res = await api.post(`/attachments?noteId=${noteId}`, formData, {
          headers: {
              'Content-Type': 'multipart/form-data'
          }
      });
      
      // Update local note with new attachment
      const attachment = res.data;
      const note = await db.notes.get(noteId);
      if (note) {
          // Remove existing version of this file if present (by filename)
          // This ensures we only show the latest version in the main list
          const otherAttachments = (note.attachments || []).filter(a => a.filename !== attachment.filename);
          const updatedAttachments = [...otherAttachments, attachment];
          await db.notes.update(noteId, { attachments: updatedAttachments, syncStatus: 'updated' });
      }
      // Keep the open note's React Query cache in sync so the sidebar updates live
      // (built from the cached note itself, so it works even if the note is not in Dexie)
      queryClient.setQueryData(queryKeys.notes.detail(noteId), (old: Note | undefined) =>
          old
              ? { ...old, attachments: [...(old.attachments ?? []).filter(a => a.filename !== attachment.filename), attachment] }
              : old
      );

      return attachment;
  } catch (error) {
      console.error('Upload failed', error);
      throw error;
  }
};

export const deleteAttachment = async (noteId: string, attachmentId: string) => {
    try {
        await api.delete(`/attachments/${attachmentId}`);
    } catch (error: unknown) {
        // If 404, the attachment is already gone from the server — clean up locally anyway
        const axiosErr = error as { response?: { status?: number } };
        if (axiosErr.response?.status !== 404) {
            throw error;
        }
    }

    const note = await db.notes.get(noteId);
    if (note) {
        const updatedAttachments = (note.attachments || []).filter(a => a.id !== attachmentId);
        await db.notes.update(noteId, { attachments: updatedAttachments, syncStatus: 'updated' });
    }
    queryClient.setQueryData(queryKeys.notes.detail(noteId), (old: Note | undefined) =>
        old ? { ...old, attachments: (old.attachments ?? []).filter(a => a.id !== attachmentId) } : old
    );
};
