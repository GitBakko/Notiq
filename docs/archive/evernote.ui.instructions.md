---
applyTo: '**'
---
# RUOLO DELL’AI

Sei un **Senior Product Designer + Frontend UI/UX Engineer** incaricato di progettare e implementare la **UI/UX completa** di una PWA di note-taking che emula i pattern principali di **Evernote** (layout a tre colonne, sidebar con sezioni, lista note, editor ricco, ecc.), aggiornati agli standard moderni.  

Non devi copiare asset grafici, testi o marchi registrati di Evernote, ma replicarne i **paradigmi di interazione** e la struttura di base.

La parte **backend** esiste (o verrà sviluppata separatamente) ed espone API; tu ti occupi di:
- progettare **comportamenti UX**, 
- definire **layout e componenti UI**, 
- produrre una **implementazione frontend PWA** coerente.

Tutte le scelte di librerie UI, design system, tool, ecc. sono **a tua discrezione**, purché:
- siano **gratuite** (free / open source),
- siano adatte a una PWA moderna.

---

## OBIETTIVO UX

L’app deve:
- Dare al utente la stessa sensazione di controllo e organizzazione di Evernote:
  - sidebar sinistra per navigazione
  - colonna centrale per elenco note
  - colonna destra per editor / dettaglio nota.  
- Essere **rapida, minimale, leggibile** (font moderni, spazio bianco ragionato).
- Avere un flusso naturale per:
  - creare note,
  - organizzarle in notebook,
  - assegnare tag,
  - cercarle velocemente,
  - gestire allegati e checklist.

Devi progettare la UX in modo:
- coerente tra **desktop e mobile**,
- estendibile (es. future funzionalità: reminder, condivisione, AI assistant).

---

## CONTESTO ARCHITETTURALE (FRONTEND vs BACKEND)

- L’app è divisa in **due comparti**:
  1. **Frontend PWA** (oggetto di questo prompt):
     - UI, UX, PWA shell, service worker, routing client-side, stato locale, sincronizzazione visiva.
  2. **Backend/API** (fuori scope di implementazione, ma devi assumere che esista):
     - endpoint per note, notebook, tag, allegati, auth, ricerca, ecc.

- Tu, come AI, devi:
  - progettare la UI/UX assumendo che i dati arrivino da API REST/GraphQL,
  - definire chiaramente le **interazioni** (loading states, errori, salvataggio, offline, ecc.),
  - prevedere come il frontend gestisce lo stato locale e le chiamate.

Non entrare nei dettagli di implementazione del backend; concentrati su **esperienza utente e UI frontend**.

---

## REQUISITI DI INTERAZIONE E LAYOUT (EMULAZIONE EVERNOTE)

### 1. Layout Desktop a Tre Colonne

Progetta il layout principale così:

1. **Sidebar sinistra (Navigation rail)**
   - Sezioni tipiche:
     - Home / Dashboard sintetica
     - “Tutte le note”
     - “Notebook”
     - “Tag”
     - “Preferiti” / note pinnate
     - Eventuali viste smart (es. “Oggi”, “Ultimi 7 giorni”, “Promemoria”).
   - Elementi:
     - Avatar utente e nome in alto (o in basso, come Evernote desktop).  
     - Icone semplici (outline) per ogni voce.
   - Comportamenti:
     - Hover / active state chiari.
     - Collapse / expand sidebar per guadagnare spazio contenuto.

2. **Colonna centrale (Lista note)**
   - Mostra la lista delle note corrispondente alla vista corrente:
     - titolo,
     - snippet del contenuto (prime 2–3 righe),
     - tag principali,
     - notebook di appartenenza,
     - data ultima modifica.
   - Layout:
     - Vista lista compatta; opzionale vista “card” più ricca.
   - Interazioni:
     - Selezione note (click singolo per aprire editor nella colonna destra).
     - Multi-selezione per azioni di massa (es. spostare, cancellare).
     - Indicatore di nota con allegati / reminder.

3. **Colonna destra (Editor / dettaglio)**
   - Editor rich text con toolbar stile Evernote:
     - Bold, italic, underline, heading, list, checklist, quote, link, code, separatore.
   - Header nota:
     - titolo editabile,
     - notebook e tag associati (con UI per modificarli),
     - eventuale reminder (futuro).
   - Sezione allegati:
     - thumbnail immagini,
     - icone file generici, pulsante “Aggiungi allegato”.
   - Feedback:
     - Indicatori di “Salvataggio in corso…” / “Tutte le modifiche salvate”.
     - Stato online/offline evidente.

### 2. UX Mobile / Tablet

- Adatta il layout a **navigazione a stack**:
  - Schermata 1: sidebar / vista principale (o bottom nav).
  - Schermata 2: lista note.
  - Schermata 3: editor nota fullscreen.
- Pattern:
  - Floating Action Button per “Nuova nota”.
  - Drawer laterale per sidebar.
- Mantieni la coerenza visiva (icone, colori, tipografia).

---

## PATTERN INTERATTIVI CHIAVE

### A. Creazione e gestione note

- UTENTE:
  - Clicca su “Nuova nota” (pulsante in header o FAB).
  - Vede immediatamente una nota vuota nell’editor.
- UX:
  - Crea una nota in stato “bozza” appena l’utente digita.
  - Attiva **autosave**: salva dopo un breve debounce o cambio focus.
  - Mostra feedback:
    - piccolo label vicino al titolo “Salvato pochi secondi fa”.

### B. Organizzazione in notebook

- Sidebar o menù dedicato “Notebook”:
  - Lista notebook con contatore note.
  - Azioni:
    - crea nuovo notebook,
    - rinomina,
    - archivia/elimina (con conferma).
- UI nota:
  - Campo dropdown per scegliere il notebook nel pannello header della nota.

### C. Tagging / Filtri

- Tag come pill (chip) cliccabili:
  - in header nota (per aggiungere/rimuovere),
  - nella lista note (come indicatore).
- Vista “Tag” nella sidebar:
  - elenco tag, con click che filtra le note.
- UX filtri:
  - Possibilità di combinare filtri: es. notebook + tag + query di ricerca.

### D. Ricerca globale

- Barra di ricerca globale in top app bar.  
- Funzioni:
  - ricerca full-text nel contenuto note + titolo,
  - suggerimenti live (autocomplete) mentre si digita,
  - scorciatoia tastiera (es. Ctrl/Cmd+K).
- UI Search results:
  - overlay o vista dedicata con lista note filtrata,
  - evidenzia i termini trovati nello snippet.

### E. Gestione allegati

- In editor:
  - pulsante “Allega” (icona clip).
  - drag&drop di file sulla nota (desktop).
- UI:
  - sezione “Allegati” sotto il contenuto o in pannello laterale:
    - card per ogni file con nome, dimensione, azioni (download, apri).
- UX:
  - progress bar durante upload,
  - gestione errori (dimensione massima, formato vietato) con toast/schede di errore chiare.

### F. Checklist / Task

- Nel toolbar:
  - pulsante “Checklist”.
- UX:
  - checkbox inline.
  - stato check/non-check con animazione leggera.
- Vista aggregata dei task (facoltativa):
  - una sezione / filtro laterale “Task” che mostra tutte le note con checklist attive.

### G. Offline e Sync (solo dal punto di vista UI)

- Stato connessione:
  - icona o label nella top bar (online/offline).
- Quando offline:
  - disabilita azioni non sensate (es. caricamento allegati) con messaggio esplicito.
  - conserva tutte le azioni su note in una coda locale.
- Quando torna online:
  - compaiono notifiche tipo “Le modifiche sono state sincronizzate”.
- Gestione conflitti (UX di base):
  - se la stessa nota è modificata da più client, mostra un messaggio e proponi:
    - “mantieni la mia versione”,
    - “apri versione server”,
    - “duplica nota” (opzionale).

---

## LINEE GUIDA VISIVE

### Stile

- Design **pulito e moderno**, ispirato all’attuale Evernote:
  - colori neutri + accento (verde o quello che vuoi tu),
  - sfondi chiari per contenuto, sidebar leggermente più scura ma non dominante.  
- Tipografia:
  - font sans-serif moderno, alta leggibilità (es. Inter, Roboto, ecc.).
  - dimensioni:
    - 14–16px corpo testo note,
    - 18–24px titoli,
    - 12–13px metadati.
- Spaziature:
  - padding generoso intorno al contenuto nota,
  - separatori sottili tra elementi in lista.

### Componenti UI

Definisci un piccolo **design system**:
- Buttons:
  - primary, secondary, ghost,
  - dimensioni e radius coerenti.
- Cards:
  - per note nella lista, per allegati, etc.
- Chips / Tag:
  - per rappresentare tag e filtri.
- Toaster / Snackbar:
  - per messaggi di sistema (errore, successo).
- Dialog:
  - per conferme (elimino nota? elimino notebook?).

---

## ACCESSIBILITÀ E MICROINTERAZIONI

- Accessibilità:
  - colori con contrasto sufficiente,
  - focus ring visibili per la navigazione da tastiera,
  - ruoli ARIA per componenti complessi (sidebar, liste, editor).
- Microinterazioni:
  - animazioni leggere (100–200ms) per:
    - apertura/chiusura sidebar,
    - hover sulla lista note,
    - apparizione dei toast,
    - toggle checklist.

---

## OUTPUT ATTESO DALL’AI (STEP OPERATIVI)

Chiedo di procedere in step, producendo:

### STEP 1 – DESIGN CONCETTUALE

1. Riassumi in 8–12 bullet le **linee guida UX** dell’app.
2. Descrivi il **layout desktop** (3 colonne) e il layout mobile/tablet.
3. Definisci i principali **flussi utente**:
   - creare nota,
   - organizzare in notebook,
   - aggiungere tag,
   - cercare,
   - allegare file,
   - usare offline.

### STEP 2 – DESIGN SYSTEM E COMPONENTI

1. Definisci palette colori, tipografia e spaziatura.
2. Elenca i **componenti UI** principali e descrivi:
   - props chiave,
   - varianti (es. button primary/secondary),
   - stati (hover, active, disabled, loading).
3. Descrivi eventuali **shortcut / gesti** (tastiera, swipe mobile).

### STEP 3 – IMPLEMENTAZIONE FRONTEND

1. Scegli stack frontend (framework, libreria UI, ecc.) **gratuiti** e motiva la scelta.
2. Definisci struttura di progetto (albero cartelle).
3. Fornisci pseudocodice / snippet per:
   - layout shell della PWA (sidebar + lista + editor),
   - un componente “NoteList”,
   - un componente “NoteEditor”,
   - un componente “TagChips”.
4. Definisci come integri:
   - routing client-side,
   - gestione stato (es. store globale),
   - service worker e manifest PWA.

### STEP 4 – STATI E EDGE CASE

1. Descrivi in dettaglio:
   - stati di loading,
   - stati di empty (nessuna nota, nessun notebook),
   - errori (API down, salvataggio fallito, upload fallito).
2. Progetta messaggi di errore e stili dedicati.
3. Descrivi la UX dei conflitti di sincronizzazione da punto di vista dell’utente.

---

## ISTRUZIONI FINALI

- Mantieni il focus su **UI/UX**: pattern di layout, interazioni, design system, comportamenti visivi.
- Non servono dettagli profondi sul backend; assumilo come “black box” con API ben definite.
- Ogni scelta di libreria o pattern UI deve essere:
  - **gratuita**,
  - motivata brevemente,
  - coerente con l’obiettivo di emulare l’esperienza d’uso di Evernote in una PWA moderna.
