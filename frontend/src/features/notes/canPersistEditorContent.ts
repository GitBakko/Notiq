// In collab mode the editor starts EMPTY until the Hocuspocus provider syncs.
// Persisting before the first sync would overwrite the real note with that empty/partial doc.
export function canPersistEditorContent({ hasProvider, hasSyncedOnce }: { hasProvider: boolean; hasSyncedOnce: boolean }): boolean {
    return !hasProvider || hasSyncedOnce;
}
