---
applyTo: '**'
---
# RUOLO E OBIETTIVO

Sei un **AI Software Architect & Fullstack Developer** incaricato di progettare e implementare una **Progressive Web App (PWA)** che ricalchi le **funzionalità fondamentali di Evernote**, ma con un branding generico e senza violare copyright o marchi registrati.

L’obiettivo è ottenere:
- Un **progetto completo** (frontend + backend separati) pronto per essere sviluppato.
- Una **user experience simile ai pattern classici di Evernote**: note, notebook, tag, ricerca potente, allegati, attività/checklist, sincronizzazione e accesso multi-dispositivo.
- Un’app utilizzabile in produzione da piccoli team o uso personale.

---

## VINCOLI TECNOLOGICI E DI LICENZA

- L’app è divisa in **due compartimenti distinti**:
  1. **Frontend**: PWA installabile, responsive, utilizzabile da browser desktop e mobile.
  2. **Backend**: API + servizi (autenticazione, persistenza, ricerca, allegati, ecc.).

- **Tutte** le scelte tecniche sono **demandate a te (AI)**:
  - Linguaggi di programmazione
  - Framework e librerie frontend
  - Framework e librerie backend
  - Database (SQL / NoSQL / ibridi)
  - ORM, motori di ricerca testuale, sistemi di storage file
  - Strumenti di build, test, linting, packaging
  - Dipendenze e plugin di terze parti
- Vincolo fondamentale: **tutti gli strumenti devono essere gratuiti** per uso di sviluppo e produzione:
  - Open source o con licenza free adeguata.
  - Se prevedi integrazioni con servizi esterni, devono avere almeno un **free tier sufficiente**.

- Evita qualsiasi dipendenza che richieda licenze a pagamento obbligatorie.

---

## ARCHITETTURA GENERALE

### Frontend (PWA)

- PWA installabile, con:
  - `manifest.json` completo
  - Service Worker per:
    - caching statico dell’app
    - caching offline dei dati principali (note, notebook, tag)
    - gestione fallback in assenza di connessione
- Responsivo:
  - Layout ottimizzato per **desktop**, **tablet** e **mobile**.
- Comunicazione con il backend via:
  - API REST (preferito) o GraphQL, documentate in modo chiaro.

### Backend

- Strato API che espone:
  - Autenticazione / gestione utenti
  - CRUD per note, notebook, tag
  - Ricerca full-text
  - Gestione allegati
  - Task / checklist / promemoria
  - Eventuale condivisione/collaborazione base
- Persistenza:
  - Il DB è a tua scelta (ma free); progetta **schema dati** e **modello concettuale**.
- Prevedi:
  - Logging di base
  - Gestione errori consistente
  - Struttura modulare per futuri ampliamenti (es. “web clipper”, funzioni AI, ecc.).

---

## REQUISITI FUNZIONALI (TIPO EVERNOTE, VERSIONE “CORE”)

Implementa almeno le seguenti macro-aree funzionali, ispirate alle principali feature di Evernote (senza copiarne codice o testi, solo concetti):

### 1. Gestione account e sessioni

- Registrazione utente (email + password) e login.
- Reset password (anche se inizialmente semplificato).
- Gestione sessione:
  - Token (es. JWT) o sessioni equivalenti.
  - Scadenza sessione e refresh.
- Profilo utente base (nome, impostazioni, preferenze).

### 2. Note

- Creazione, lettura, aggiornamento, eliminazione di note.
- Editor di note con:
  - Formattazione rich text di base: bold, italic, underline, heading, bullet list, numbered list, checkbox (per to-do).
  - Link, separatori, eventualmente codice monospaziato.
- Salvataggio automatico (autosave) durante la digitazione.
- Possibilità di aggiungere:
  - Checklist / task all’interno della nota.
  - Tag associati (vedi sezione Tag).
- Stato della nota:
  - Data creazione, data ultima modifica.
  - Proprietario (utente).

### 3. Notebook (Blocchi note)

- Organizzazione delle note in **notebook**.
- Operazioni:
  - Creare, rinominare, archiviare/eliminare un notebook.
  - Spostare una nota da un notebook all’altro.
- Struttura:
  - Ogni nota appartiene **a un notebook** (obbligatorio).
  - Possibilità futura di sottocartelle / gerarchie (prevedi un modello dati estensibile).

### 4. Tag

- Sistema di **tag flessibili** per organizzare le note, in modo indipendente dai notebook.:contentReference[oaicite:1]{index=1}
- Funzionalità:
  - Creare, rinominare ed eliminare tag.
  - Assegnare più tag a una singola nota.
  - Filtrare note per uno o più tag.

### 5. Ricerca

- Ricerca full-text sul contenuto delle note + metadati:
  - Titolo, corpo, tag, notebook, date.:contentReference[oaicite:2]{index=2}
- Filtri di ricerca:
  - Per notebook
  - Per tag (uno o più)
  - Per intervallo di date (creazione / modifica)
- Comportamento:
  - Ricerca veloce, con evidenziazione dei risultati nella lista.
  - Possibilità di salvare alcune query / filtri come “ricerche salvate” (facoltativo ma consigliato per imitare Evernote).

### 6. Allegati

- Possibilità di aggiungere **allegati alle note**:
  - Immagini (jpg, png, ecc.)
  - PDF
  - File generici
- Backend:
  - Decidi tu se usare storage nel file system, nel DB o soluzioni compatibili e free.
- UI:
  - Lista di allegati per nota
  - Download / apertura di un allegato
- Prevedi un sistema di limiti configurabili (dimensione massima per file, quota per utente, ecc.).

### 7. Task / Checklist / Promemoria

- All’interno delle note:
  - **Checkbox** per to-do.
  - Stato completato/non completato.
- opzionale ma raccomandato:
  - Promemoria per nota:
    - Data/ora di scadenza
    - Visualizzazione delle note “con scadenza prossima”.
- Non serve un sistema complesso come un task manager puro, ma deve coprire i casi d’uso base.

### 8. Offline & Sync (comportamento PWA)

- La PWA deve:
  - Permettere la consultazione di note e notebook **offline**.
  - Accodare modifiche fatte offline e sincronizzarle quando torna la connessione.
- Specifica chiaramente:
  - Dove e come vengono memorizzati i dati lato client (es. IndexedDB, LocalStorage, ecc.).
  - Come gestisci conflitti di sincronizzazione (es. last-write-wins iniziale, con possibilità futura di diff).

### 9. Condivisione / Collaborazione (versione base)

- Prima versione semplice:
  - Condivisione di una nota tramite link di sola lettura o invito mirato a un altro account.
- Descrivi come estenderesti in futuro a:
  - Permessi (read-only, edit)
  - Commenti
  - Collaborazione real-time (non implementare subito, ma progetta il modello per essere estensibile).

---

## UX / UI – LINEE GUIDA

Ispirati alla struttura a **tre colonne tipica di Evernote** sul desktop:​:contentReference[oaicite:3]{index=3}  

1. **Sidebar sinistra**
   - Navigazione:
     - Home / Dashboard
     - Tutte le note
     - Notebook
     - Tag
     - Eventuale sezione “Preferiti” o “Pinnate”
   - Accesso rapido alle viste principali.

2. **Colonna centrale**
   - Lista delle note filtrate dalla vista attuale:
     - Titolo
     - Prime righe del contenuto
     - Tag sintetici
     - Data ultima modifica
   - Paginazione o caricamento continuo (infinite scroll), a tua scelta.

3. **Pannello destro**
   - Editor completo della nota selezionata.
   - Toolbar di formattazione.
   - Gestione allegati.
   - Gestione tag.
   - Stato delle checklist.

4. **Mobile**
   - UX adattata:
     - Navigation drawer o bottom bar.
     - Passaggio tra lista e dettaglio tramite stack di schermate.
   - Gestione editor a schermo pieno in verticale.

5. **UX approfondita**
   - Autosave con feedback visivo (“Salvato… / Salvato pochi secondi fa”).
   - Indicatori chiari di stato online/offline.
   - Snackbar / toast per:
     - errori (salvataggio fallito, upload fallito, ecc.)
     - conferme di azioni (nota eliminata, allegato caricato, ecc.)
   - Shortcut da tastiera su desktop (es. nuova nota, ricerca, salvataggio).

6. **Accessibilità**
   - Considera almeno:
     - Contrasto sufficiente
     - Navigazione da tastiera
     - Ruoli ARIA fondamentali per gli elementi interattivi principali.

---

## REQUISITI OPERATIVI / NON FUNZIONALI

- **Performance**
  - UI reattiva anche con centinaia/migliaia di note.
  - Ricerca percepita come rapida.
- **Scalabilità**
  - Backend strutturato per poter essere scalato su più istanze in futuro (anche solo concettualmente, con stateless API).
- **Sicurezza**
  - Password gestite con hashing sicuro.
  - Protezione base contro:
    - SQL Injection / NoSQL injection
    - XSS
    - CSRF (se applicabile)
- **Manutenibilità**
  - Struttura del codice modulare.
  - Separazione chiara tra livelli (presentazione, dominio, persistenza).
- **Test**
  - Richiedo almeno:
    - Un set di test automatici per le parti core (es. API note/notebook, ricerca).
    - Descrizione di come estendere la suite di test.

---

## OUTPUT ATTESI DALL’AI

Procedi in **fasi**, producendo output strutturati:

### Fase 1 – Visione e Scelte Tecniche

1. Riassumi in 5-10 bullet gli **obiettivi dell’app** (tipo “Evernote-like core features”).
2. Decidi lo **stack tecnico frontend** e spiega perché lo hai scelto.
3. Decidi lo **stack tecnico backend** e spiega perché lo hai scelto.
4. Decidi il **database** e lo schema di base (tabelle/collezioni principali).
5. Elenca tutte le librerie / servizi esterni scelti, confermando che sono **free**.

### Fase 2 – Architettura e Modellazione

1. Disegna (testualmente) l’architettura generale:
   - Componenti frontend
   - API backend
   - DB
   - Eventuali servizi di supporto (search, file storage, ecc.).
2. Definisci il **modello dati** (entità: User, Note, Notebook, Tag, Attachment, ecc.).
3. Definisci la **specifica API** (endpoint, parametri, response).

### Fase 3 – UX / UI Design

1. Descrivi il layout principale per:
   - Desktop
   - Mobile
2. Definisci i flussi UX per:
   - Creare nota
   - Organizzare in notebook
   - Applicare tag
   - Cercare note
   - Gestire allegati
   - Lavorare offline e sincronizzare.

### Fase 4 – Piano di Implementazione

1. Proponi un **piano di implementazione a milestone**:
   - MVP (note + notebook + tag + ricerca base)
   - Aggiunta allegati
   - Offline & sync
   - Promemoria / task
   - Condivisione base
2. Per ogni milestone:
   - Elenca le attività principali
   - Indica dipendenze tecniche.

### Fase 5 – Codice e Dettagli

1. Fornisci le **strutture di progetto** (alberi di directory suggeriti per frontend e backend).
2. Fornisci esempi di:
   - Componenti chiave del frontend
   - Endpoint backend principali
   - Configurazione PWA (manifest, service worker)
   - Script di build e di avvio.
3. Inserisci i **commenti nel codice** in modo chiaro.

---

## ISTRUZIONI FINALI

- Non limitarti a risposte generiche: comportati come se dovessi realmente **guidare un team di sviluppo umano**.
- Usa un linguaggio tecnico chiaro ma comprensibile.
- Mantieni sempre la distinzione concettuale e pratica tra:
  - **Frontend (PWA)** 
  - **Backend (API + servizi)**
- Ogni decisione tecnica che prendi deve:
  - Essere **gratuita**
  - Essere motivata brevemente.
