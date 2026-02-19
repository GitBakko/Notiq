# Roadmap Pubblicazione App Notiq (v1.0)

Questo piano dettagliato guida l'implementazione completa, partendo dalla correzione dell'architettura offline-first per i Notebooks fino al deploy finale.

## Phase 1: Completamento UI & Refactoring Core (COMPLETATO)
**Obiettivo:** Rendere l'app completamente navigabile e funzionale offline.

### Steps
- [x] **Refactoring Notebook Service:** Modificare `notebookService.ts` per offline-first (Dexie + SyncQueue).
- [x] **Notebooks UI:** Creare `NotebooksPage.tsx` e `NotebookList.tsx`.
- [x] **Tags UI:** Creare `TagsPage.tsx` e implementare gestione tag.
- [x] **Trash Management:** Implementare logica di cestino e ripristino (`TrashPage.tsx`).

## Phase 2: Sync Engine Hardening (COMPLETATO)
**Obiettivo:** Sincronizzazione robusta e bidirezionale.

### Steps
- [x] **Sync Queue Expansion:** Supporto sync per `NOTEBOOK` e `TAG`.
- [x] **Smart Pull:** Logica upsert per preservare modifiche locali.
- [x] **Conflict Handling:** Logica base implementata (Server Wins).

## Phase 3: Versioning Allegati & Backend (COMPLETATO)
**Obiettivo:** Gestione file sicura e versionata.

### Steps
- [x] **Schema Update:** Aggiunti `version`, `hash`, `isLatest` a Prisma.
- [x] **Upload Logic:** Implementato hashing SHA-256 e versioning incrementale.
- [x] **Backend Tests:** Logica implementata e verificata staticamente.

## Phase 4: Operations & Maintenance (COMPLETATO)
**Obiettivo:** Automazione e stabilità in produzione.

### Steps
- [x] **Pruning Job:** Script `pruneAttachments.ts` creato.
- [x] **Backup System:** Script `backup.ts` creato.
- [x] **Deploy:** Docker Compose, Dockerfiles e Nginx configurati.

## Phase 5: Refinement & Polish (COMPLETATO)
**Obiettivo:** Migliorare l'esperienza utente e la qualità del codice.

### Steps
- [x] **Rich Text Editor:** Implementata Toolbar di formattazione.
- [x] **Search Experience:** Implementata ricerca globale (Cmd+K) su DB locale.
- [x] **Authentication Flow:** Verificato redirect e gestione token.
- [x] **Testing:** Scrivere test E2E (Cypress/Playwright) per i flussi critici.

## Further Considerations
1.  **Database:** L'ambiente di sviluppo è configurato per PostgreSQL.
2.  **Porte:** Backend standardizzato sulla porta 3001.

