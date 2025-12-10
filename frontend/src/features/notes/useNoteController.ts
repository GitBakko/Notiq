import { useCallback } from 'react';
import { updateNote } from './noteService';
import type { Note } from './noteService';

export function useNoteController(note: Note) {

  // Defines the update function that commits to DB
  const saveNote = useCallback(async (updates: Partial<Note>) => {
    if (!note?.id) return;
    try {
      await updateNote(note.id, updates);
    } catch (error) {
      console.error('Failed to save note:', error);
    }
  }, [note?.id]);

  // We can also expose specific handlers if needed, or just a generic update
  const updateTitle = useCallback((title: string) => {
    saveNote({ title });
  }, [saveNote]);

  const updateContent = useCallback((content: string) => {
    saveNote({ content });
  }, [saveNote]);

  return {
    updateTitle,
    updateContent,
    saveNote
  };
}
