# Vault P2: primo giro manuale (35 voci BLOCCANTE)

Tratto da `docs/superpowers/plans/2026-10-22-vault-p2-manual-checklist.md`. I testi attesi sono quelli italiani di `it.json`. "da osservare" vuol dire che l'atteso non è certo.

Ambiente di partenza: backend su :3001 con `VAULT_SETUP_USERS='*'` come variabile del processo, Vite su http://localhost:5173, DB `notiq-db` sulla porta 5433.

---

## Preparazione minima

### 1. Dove passano le chiamate /api (da fare per primo)
- Dopo il login apri Network e guarda l'host di una richiesta `/api/...` qualsiasi:
  - `localhost:5173` vuol dire proxy di Vite (`VITE_API_URL=/api`);
  - `localhost:3001` vuol dire chiamata diretta.
- Annota l'esito: serve per i filtri di Request blocking.
- Gli snippet S-API e la Ricetta A usano `http://localhost:3001/api` e funzionano in entrambi i casi.

### 2. Riavvio del backend e kill switch
`VAULT_SETUP_USERS` si legge solo da `process.env`, quindi serve un riavvio. Ferma il backend con Ctrl+C e controlla che la porta 3001 sia libera. Poi, in PowerShell, da `D:\Develop\AI\Notiq\backend`:

| Stato | Comando |
|---|---|
| Aperto a tutti | `$env:VAULT_SETUP_USERS='*'; npm run dev` |
| Chiuso | `Remove-Item Env:VAULT_SETUP_USERS -ErrorAction SilentlyContinue; npm run dev` |
| Canary | `$env:VAULT_SETUP_USERS='<userIdA>'; npm run dev` |
| Lista con spazi | `$env:VAULT_SETUP_USERS=' <userIdA> , <userIdB> '; npm run dev` |

- In PowerShell `$env:X=''` **cancella** la variabile.
- `dotenv` non sovrascrive una variabile già presente nel processo. Con lo stato "chiuso", se `GET /api/vault/keyring` di un utente NONE risponde ancora `setupAllowed:true`, allora `backend/.env` contiene un valore di `VAULT_SETUP_USERS`. Controllalo tu: il file originale non l'ha letto.
- Le variabili restano nella sessione PowerShell. A fine prova riavvia con `'*'`, perché gli E2E ne hanno bisogno.
- I rate limit stanno in memoria, sono per utente e si azzerano a ogni riavvio:
  - GET `/keyring`: 60 al minuto;
  - POST `/keyring`: 5 all'ora;
  - PUT `/keyring`: 10 all'ora (cambio PIN e rigenerazione del Kit insieme);
  - POST `/unlock`: 10 al minuto;
  - `/migrate`: 20 al minuto;
  - `/finalize`: 20 al minuto;
  - `/vault/items`: 60 al minuto.

Ordine dei riavvii nella sezione A, per ridurre i cambi di stato:
1. `'*'`: A.1 a kill switch aperto, A.2;
2. chiuso: A.1 a kill switch chiuso, A.3, A.5;
3. canary: A.4;
4. di nuovo `'*'` per tutte le sezioni dopo.

Prima di partire, con `'*'`, crea R0 READY dalla UI: un setup rapido, una nota sicura e una credenziale.

### 3. Account
- **SUPERADMIN dev**: `superadmin@notiq.ai` / `superadmin`. Serve per gli inviti e come canary dev.
- **Ricetta di creazione** (PowerShell). Usa nome e cognome veri, per esempio "Mario Rossi": servono alla regola `personal` della policy del PIN.
  ```powershell
  $sa = Invoke-RestMethod -Method Post http://localhost:3001/api/auth/login -ContentType 'application/json' -Body '{"email":"superadmin@notiq.ai","password":"superadmin"}'
  $h = @{ Authorization = "Bearer $($sa.token)" }
  $code = (Invoke-RestMethod -Method Post http://localhost:3001/api/invites -Headers $h).code
  try { Invoke-RestMethod -Method Post http://localhost:3001/api/auth/register -ContentType 'application/json' -Body (@{email='mario.rossi1@example.com';password='password123';name='Mario Rossi';invitationCode=$code} | ConvertTo-Json) } catch {}   # lo SMTP può fallire: l'utente nasce lo stesso
  $u = (Invoke-RestMethod "http://localhost:3001/api/admin/users?search=mario.rossi1%40example.com" -Headers $h).users[0]
  Invoke-RestMethod -Method Put "http://localhost:3001/api/admin/users/$($u.id)" -Headers $h -ContentType 'application/json' -Body '{"isVerified":true}'
  $u.id
  ```
- Ogni setup consuma il keyring, e il keyring non si azzera dalla UI. Annota `email → userId → uso`. Per questo giro servono:

| Utente | Uso |
|---|---|
| U25 | Senza keyring, con 3-4 note normali (una con allegato, una condivisa). A.1 |
| U60 | Senza keyring, con più di 60 note. A.2 |
| N1, N2, N3 | Senza keyring (A.3, A.4). In A.3 N2 deve avere il modulo di setup già aperto prima del riavvio |
| F_ALTRO | Con almeno una nota vault legacy (A.3) |
| E_CANARY | Canary (A.4) |
| R0 | READY, creato in anticipo con il kill switch aperto, con una nota sicura e una credenziale (A.5) |
| L1, L2, L5 | Legacy con la Ricetta A, uno per giro (B.1/B.2, B.4, B.8) |
| N7 | "Mario Rossi", mario.rossi2@example.com (C.2) |
| 5 utenti nuovi | D.4, oppure il DELETE del keyring fra un giro e l'altro |
| R1 | Utente principale READY, sblocco offline ON, una nota sicura "Segreto A" e una credenziale "Banca A" (utente alice@example.com, password S3cret-Pass-42). Serve a E.14, E.16, F.1, J.1, J.5 |
| R2 | Solo per il lockout (sblocco offline OFF). E.4 |
| un utente per B | Utente dedicato su Edge con offline ON per J.7. Serve anche l'account R1 su B per J.5 |
| C1, C2 | Concorrenza su DB (L.1, L.2). Vanno buttati |

- Per rifare il setup con lo stesso utente (solo dev, solo per utenti senza note vault):
  1. `DELETE FROM "VaultKeyring" WHERE "userId"='<id>';`
  2. Nel browser: DevTools, Application, Clear site data.

### 4. PIN di prova
- PIN1 = `x9Kp4M` (il PIN1 con maiuscole e minuscole invertite è `X9kP4m`).
- PIN errato = `K7rQ2X`.
- PIN2 = `m4Tz8q`. Non l'ho provato contro la policy: se la policy lo rifiuta, scegline un altro di 6 caratteri con lettere e cifre.
- PIN per B.4: `q4Wm7Z`.
- PIN legacy per la Ricetta A: `oldPin1`, `passPhrase9` e `unknown77`. Non fornire mai `unknown77`.

### 5. Dispositivi e profili
- **A**: il profilo principale di Chrome su :5173.
- **B**: un secondo browser (Edge) o un secondo profilo Chrome, se lo storage deve sopravvivere alla chiusura. Per le prove da una sola sessione basta l'incognito.
- **Origine :4173** (vite preview): conta come un dispositivo nuovo, con storage separato.

### 6. DevTools da tenere aperti
- **Network**: Preserve log; filtri `vault`, `notes`, `vault/items|api/notes`. Controlla l'header `Cache-Control: no-store` sulle risposte `/api/vault/*`, comprese quelle di errore.
- **Application**:
  - Local Storage: `vault-storage` (`state.byUser[userId]`), `auth-storage`, `api-cache-purged`;
  - IndexedDB `notiq-vault-device`: store `deviceKeys`, `shares` e `pending` (chiavi `<userId>:kit` e `<userId>:pin`);
  - IndexedDB `NotiqDB`: `notes`, `syncQueue`, `tags`;
  - Cache Storage; Service Workers.
  - La vista IndexedDB non si aggiorna da sola: usa il tasto refresh.
- **Request blocking** (Ctrl+Shift+P, "Show Request Blocking"): pattern `*/api/*` oppure `localhost:3001/api/notes*`. Con il proxy diventa `localhost:5173/api/notes*`. Il server risulta irraggiungibile con `navigator.onLine` ancora true.
- **Throttling personalizzato** "Notiq lenta": latenza 4000 ms, 200 kbps. Usa anche Slow 3G.
- **Breakpoint XHR** (Sources, XHR/fetch Breakpoints): `/vault/finalize` per B.8. Axios usa XHR, quindi la pausa scatta prima dell'invio. Premi F8 per le pause che non interessano.

### 7. Snippet da Console (nella scheda dell'app, dopo il login)

Userid, token e keyring:
```js
JSON.parse(localStorage.getItem('auth-storage')).state.user.id
JSON.parse(localStorage.getItem('auth-storage')).state.token
fetch('/api/vault/keyring',{headers:{Authorization:'Bearer '+JSON.parse(localStorage.getItem('auth-storage')).state.token}}).then(r=>r.json()).then(console.log)
```

**S-DUMP**: cerca un ago in tutti gli storage del dispositivo. Atteso: `trovato=false` per ogni ago, e il conteggio `nv3.` maggiore di 0 quando ci sono item vault. Aprire `notiq-vault-device` lo crea vuoto se non esiste: non è un errore.
```js
(async (needles) => { const dump = async (name) => { const db = await new Promise((ok, ko) => { const o = indexedDB.open(name); o.onsuccess = () => ok(o.result); o.onerror = () => ko(o.error); }); const out = {}; for (const n of db.objectStoreNames) out[n] = await new Promise((ok) => { const q = db.transaction(n).objectStore(n).getAll(); q.onsuccess = () => ok(q.result); }); db.close(); return out; }; let s = JSON.stringify({ notiq: await dump('NotiqDB'), dev: await dump('notiq-vault-device'), ls: { ...localStorage }, ss: { ...sessionStorage } }); for (const k of await caches.keys()) { const c = await caches.open(k); for (const r of await c.keys()) s += r.url + ' ' + (await (await c.match(r)).text()); } console.table(needles.map((x) => ({ needle: x, trovato: s.includes(x) }))); console.log('occorrenze nv3.:', (s.match(/nv3\./g) || []).length); })(['AGO-1','AGO-2'])
```

**S-NQ**: stato locale di una nota con `nq('ID')`, oppure di tutte con `nq()`. "Sincronizzato" vuol dire tre cose: `row = base = hash del server`, `sent=[]`, nessun item in coda.
```js
window.nq = async function(id){ var db = await new Promise(function(ok,ko){var o=indexedDB.open('NotiqDB');o.onsuccess=function(){ok(o.result)};o.onerror=ko}); function all(s){return new Promise(function(ok){var r=db.transaction(s).objectStore(s).getAll();r.onsuccess=function(){ok(r.result)}})} var notes=await all('notes'); var q=await all('syncQueue'); db.close(); async function h(s){var d=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s||''));return Array.from(new Uint8Array(d)).map(function(b){return b.toString(16).padStart(2,'0')}).join('')} for (var n of notes.filter(function(n){return !id || n.id===id})){ console.log(n.id, 'vault='+n.isVault, n.syncStatus, 'title=['+n.title+']', (n.content||'').slice(0,10), 'base='+n.vaultBaseHash, 'row='+(await h(n.content)), 'sent='+JSON.stringify(n.vaultSentHashes||[])) } console.table(q.filter(function(i){return !id || i.entityId===id}).map(function(i){return {qid:i.id,type:i.type,entity:i.entity,id:i.entityId,status:i.status,lastError:i.lastError,attempts:i.attempts,keys:Object.keys(i.data||{}).join(',')}})) }
```

**S-SQ**: stato del server, con `sq()` per il listing e `sq(['ID'])` per un id (`absent` / `notVault`). Ogni chiamata conta nel limite di 60 al minuto.
```js
window.sq = async function(ids){ var t=JSON.parse(localStorage.getItem('auth-storage')).state.token; var r=await fetch('/api/vault/items',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+t},body:JSON.stringify(ids?{ids:ids}:{})}); var j=await r.json(); console.table((j.items||[]).map(function(i){return {id:i.id,type:i.noteType,hash:i.contentHash,upd:i.updatedAt}})); console.log('absent',j.absent,'notVault',j.notVault,'next',j.next) }
```

**S-API** (usato in A.2):
```js
const TOK = JSON.parse(localStorage.getItem('auth-storage')).state.token; const API = 'http://localhost:3001/api'; const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOK }; const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join(''); const get = (id) => fetch(API + '/notes/' + id, { headers: H }).then((r) => r.json()); const put = (id, b) => fetch(API + '/notes/' + id, { method: 'PUT', headers: H, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, cc: r.headers.get('cache-control'), body: await r.json() }));
```

**Lock** (H.2): `await navigator.locks.query()` mostra `notiq-vault-note:<id>` (shared o exclusive) e `notiq-vault-reconcile`.

### 8. Dati legacy: Ricetta A (via REST)
Serve a B.1, B.2, B.4, B.8. Il server accetta le scritture legacy finché non esiste un keyring. Eseguila da loggato con l'utente L* nuovo, **prima di aprire /vault**:
```js
const API='http://localhost:3001/api'; const tok=JSON.parse(localStorage.getItem('auth-storage')).state.token;
const H={'Content-Type':'application/json',Authorization:'Bearer '+tok};
const j=async r=>{const t=await r.text(); if(!r.ok) throw new Error(r.status+' '+t); return t?JSON.parse(t):null;};
const nbs=await j(await fetch(API+'/notebooks',{headers:H})); const notebookId=(Array.isArray(nbs)?nbs:nbs.notebooks)[0].id;
const { encryptContent } = await import('/src/utils/crypto.ts');
let CryptoJS; try { CryptoJS=(await import('/@id/crypto-js')).default; } catch { CryptoJS=(await import(performance.getEntriesByType('resource').map(e=>e.name).find(n=>n.includes('/deps/crypto-js')))).default; }
const doc=s=>JSON.stringify({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:s+' '+'x'.repeat(200)}]}]});
const cred=o=>JSON.stringify({siteUrl:'',username:'',password:'',notes:'',...o});
const post=async b=>{const id=crypto.randomUUID(); await j(await fetch(API+'/notes',{method:'POST',headers:H,body:JSON.stringify({id,notebookId,isVault:true,...b})})); return id;};
const ids={};
ids.noteA=await post({noteType:'NOTE',title:'MK-TITLE-A',content:doc('MK-BODY-A'),isEncrypted:false});
ids.noteC=await post({noteType:'NOTE',title:'MK-TITLE-C',content:doc('MK-BODY-C'),isEncrypted:true});
ids.noteTrash=await post({noteType:'NOTE',title:'MK-TITLE-T',content:doc('MK-BODY-T'),isEncrypted:false});
await j(await fetch(API+'/notes/'+ids.noteTrash,{method:'PUT',headers:H,body:JSON.stringify({isTrashed:true})}));
await j(await fetch(API+'/notes/'+ids.noteA,{method:'PUT',headers:H,body:JSON.stringify({content:doc('MK-BODY-A v2')})})); // NoteVersion in chiaro
ids.credV2=await post({noteType:'CREDENTIAL',title:'MK-TITLE-CV2',isEncrypted:true,content:encryptContent(cred({siteUrl:'https://v2.example.com',username:'user-v2',password:'MK-PW-CV2',notes:'n'}),'oldPin1')});
ids.credPP=await post({noteType:'CREDENTIAL',title:'MK-TITLE-CPP',isEncrypted:true,content:CryptoJS.AES.encrypt(cred({username:'user-pp',password:'MK-PW-CPP'}),'passPhrase9').toString()});
ids.credLock=await post({noteType:'CREDENTIAL',title:'MK-TITLE-LOCK',isEncrypted:true,content:encryptContent(cred({username:'user-lock',password:'MK-PW-LOCK'}),'unknown77')});
ids.credEmpty=await post({noteType:'CREDENTIAL',title:'MK-TITLE-EMPTY',isEncrypted:true,content:''});
ids.credJson=await post({noteType:'CREDENTIAL',title:'MK-TITLE-JSON',isEncrypted:false,content:cred({username:'user-json',password:'MK-PW-JSON'})});
ids.big=await post({noteType:'NOTE',title:'MK-TITLE-BIG',content:doc('MK-BODY-BIG'+'y'.repeat(1700000)),isEncrypted:false}); // tooLarge
console.table(ids); copy(JSON.stringify(ids));
```
- La riga di CryptoJS prova prima `/@id/crypto-js` e poi la risorsa già caricata. Se fallisce in entrambi i modi, salta `credPP`.
- Controllo finale: GET keyring risponde `status NONE` e `legacyCount 9`.

### 9. SQL sul DB dev
Usa pgAdmin, oppure `docker exec -it notiq-db psql -U <utente di DATABASE_URL> -d evernote_clone`. In psql imposta prima `\set u '<userId>'`.
```sql
-- keyring / lockout
SELECT "userId",status,epoch,rev,"migrationState","failedAttempts","lockedUntil",md5("escrowBlob") escrow,md5("pinSalt") salt FROM "VaultKeyring" WHERE "userId"=:'u';
UPDATE "VaultKeyring" SET "failedAttempts"=0,"lockedUntil"=NULL WHERE "userId"=:'u';          -- reset lockout
-- Q1 stato delle righe vault
SELECT id,"noteType",title,left(content,12) head,length(content) len,md5(content) md5,"isEncrypted","isTrashed","isPinned","searchText" IS NULL st_null,"ydocState" IS NULL y_null,("searchVector" IS NULL OR "searchVector"=''::tsvector) sv_empty FROM "Note" WHERE "userId"=:'u' AND "isVault" ORDER BY "createdAt";
-- Q2 legacyCount
SELECT count(*) FROM "Note" WHERE "userId"=:'u' AND "isVault" AND content NOT LIKE 'nv3.%';
-- Q3 versioni in chiaro per nota
SELECT n.id,n."noteType",count(v.id) FILTER (WHERE v.content NOT LIKE 'nv3.%') plain_v,count(v.id) all_v FROM "Note" n LEFT JOIN "NoteVersion" v ON v."noteId"=n.id WHERE n."userId"=:'u' AND n."isVault" GROUP BY 1,2;
-- Q5 audit
SELECT event,details,"createdAt" FROM "AuditLog" WHERE "userId"=:'u' AND event LIKE 'vault.%' ORDER BY "createdAt";
-- Q6 una nota
SELECT "isVault","isEncrypted","isPublic","shareId",title,left(content,12),"searchText" IS NULL,"ydocState" IS NULL FROM "Note" WHERE id='<id>'; SELECT count(*) FROM "SharedNote" WHERE "noteId"='<id>'; SELECT left(content,8),count(*) FROM "NoteVersion" WHERE "noteId"='<id>' GROUP BY 1;
-- INVARIANTE (atteso 0)
SELECT count(*) FROM "Note" WHERE "isVault" AND "userId"=:'u' AND (content !~ '^nv3\.(0|[1-9][0-9]{0,8})\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$' OR title<>'' OR "searchText" IS NOT NULL OR "ydocState" IS NOT NULL);
-- Q7 globale di fine giornata (atteso 0)
SELECT count(*) FROM "NoteVersion" v JOIN "Note" n ON n.id=v."noteId" WHERE n."isVault" AND v.content NOT LIKE 'nv3.%' AND NOT EXISTS (SELECT 1 FROM "Note" x WHERE x.id=n.id AND x.content NOT LIKE 'nv3.%');
-- ricerca di un ago (atteso 0 righe)
SELECT 'Note' t,id FROM "Note" WHERE title ILIKE '%SEGRETO%' OR content ILIKE '%SEGRETO%' OR "searchText" ILIKE '%SEGRETO%' UNION ALL SELECT 'NoteVersion',id FROM "NoteVersion" WHERE content ILIKE '%SEGRETO%' OR title ILIKE '%SEGRETO%' UNION ALL SELECT 'KanbanCard',id FROM "KanbanCard" WHERE title ILIKE '%SEGRETO%' OR description ILIKE '%SEGRETO%' UNION ALL SELECT 'TaskItem',id FROM "TaskItem" WHERE text ILIKE '%SEGRETO%' UNION ALL SELECT 'AuditLog',id FROM "AuditLog" WHERE details::text ILIKE '%SEGRETO%';
```

### 10. Build di prod con il Service Worker (per K.1 e K.2)
In dev il SW non è attivo. Da `D:\Develop\AI\Notiq\frontend`:
```powershell
$env:VITE_WS_URL='ws://localhost:4173/ws'; npm run build
npx vite preview --port 4173 --strictPort
```
- **L'override di `VITE_WS_URL` è obbligatorio.** `.env.production` punta a `wss://notiq.epartner.it/ws`. Senza override, la build locale aprirebbe la WS di collab e chat verso la **PROD**.
- Dopo i test: Unregister del SW e Clear site data su :4173.

---

## A. Utente senza keyring, kill switch e stati del Gate

- [ ] **A.1 — Utente senza keyring: note normali invariate, nessun traffico vault, "Aggiungi al Vault" porta al setup senza toccare la nota**
  - Prec.: U25 senza keyring, con 3-4 note normali (una con allegato, una condivisa). Ripeti tutto con il kill switch aperto e poi chiuso.
  - Passi:
    1. Usa /notes come al solito: crea, modifica, rinomina, cestina e ripristina. Poi, offline, modifica una nota, torna online e verifica il sync.
    2. Per tutto il passo 1 tieni Network con il filtro `vault`.
    3. Apri Impostazioni, sezione Vault, e controlla le voci presenti.
    4. Fai logout e login.
    5. Apri una nota normale, scrivi del testo e, prima che scada il debounce, scegli "Aggiungi al Vault" dal menu.
    6. Controlla `GET /api/notes/<id>`.
  - Atteso:
    - Nessuna chiamata `/api/vault/*` durante il passo 1.
    - In Impostazioni non c'è lo switch "Sblocco offline". Ci sono "Come funziona" e il link.
    - Kill switch aperto: si va a /vault, con il modulo di setup.
    - Kill switch chiuso: "Il vault non è ancora disponibile."
    - In entrambi i casi la nota resta NORMALE: `isVault:false`, titolo in chiaro, testo appena scritto salvato (flush prima della navigazione).
  - Non deve: chiamate vault periodiche; nota svuotata, cifrata o persa; testo perso nella navigazione; errori in Console.

- [ ] **A.2 — Utente con più di 50 note: la pull completa non cancella righe (T0, TIER 1, vale per tutti gli utenti)**
  - Prec.: U60 senza keyring, con 62 note. Seed da loggato con U60 (S-API caricato). Se compare un 429, attendi e riprendi dall'indice stampato:
    ```js
    const nbs=await (await fetch(API+'/notebooks',{headers:H})).json(); const nb=(Array.isArray(nbs)?nbs:nbs.notebooks)[0].id; for (let i=0;i<62;i++){ const r=await fetch(API+'/notes',{method:'POST',headers:H,body:JSON.stringify({id:crypto.randomUUID(),notebookId:nb,title:'PULL-'+String(i).padStart(2,'0'),content:JSON.stringify({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'pull '+i}]}]})})}); if(!r.ok){console.log(i,r.status);break;} }
    ```
  - Passi:
    1. Fai login su un browser pulito (profilo B o incognito).
    2. Dopo la pull conta le righe di U60 in Dexie `notes`.
    3. Vai offline e modifica la nota più vecchia (PULL-00).
    4. Torna online e attendi la push.
    5. Ricarica e riconta.
  - Atteso:
    - Una sola richiesta `GET /api/notes?includeTrashed=true&all=1`.
    - 62 righe in Dexie, nessuna riga `synced` cancellata.
    - PULL-00 resta in lista e la modifica arriva al server.
  - Non deve: lista ferma a 50; note sparite dopo la pull o dopo il reload.

- [ ] **A.3 — Kill switch chiuso: setupAllowed:false, schermata "non disponibile", 503 dal modulo già aperto, Riprova**
  - Prec.: N1 (NONE). N2 con il modulo di setup GIÀ aperto in un'altra finestra prima del riavvio. F_ALTRO (legacy). Backend riavviato "chiuso".
  - Passi:
    1. N1 su /vault. In Network controlla la GET `/keyring`.
    2. Su N2, con il modulo già aperto, compila e clicca "Crea Vault". Ripeti con una password sbagliata.
    3. F_ALTRO su /vault.
    4. Con N1 sulla schermata "non disponibile", metti Offline e poi Online in DevTools.
    5. Riavvia con `'*'` e su N1 clicca "Riprova". Fai lo stesso su F_ALTRO.
    6. Confronta il testo con il piano §5.3 (D2): "Il nuovo vault sarà disponibile a breve; finora il tuo vault non è accessibile da questa versione".
  - Atteso:
    - Passo 1: `status NONE`, `setupAllowed:false`. Schermata col lucchetto, "Il vault non è ancora disponibile." (`errors.vault.setupDisabled`) e il pulsante "Riprova". Nessun modulo, nessun wizard, nessuna schermata "Sei offline".
    - Passo 2: dopo il calcolo, POST `/keyring` 503 e lo stesso messaggio sotto il modulo. Nessun Kit, nessun `<userId>:kit` in `pending`, nessuna riga in SQL. Con la password sbagliata il messaggio è ancora setupDisabled, perché il kill switch viene controllato prima della password.
    - Passo 3: F_ALTRO vede lo stesso testo, senza wizard e senza plaintext legacy.
    - Passo 4: all'evento online la GET riparte.
    - Passo 5: compare il setup o il wizard senza ricaricare.
    - Passo 6, da decidere: il testo attuale è più corto e non dice all'utente legacy che il suo vault non è accessibile.
  - Non deve: setup o wizard con `setupAllowed:false`; keyring creato; marker rimasto dopo il 503; schermata offline al posto del messaggio.
  - Nota: il 503 setupDisabled non scrive un audit (residuo accettato).

- [ ] **A.4 — Canary: un userId, poi una lista con spazi, poi un id sbagliato**
  - Prec.: E_CANARY e N3 (NONE), con gli userId annotati. Riavvio canary con l'id di E_CANARY.
  - Passi:
    1. E_CANARY su /vault: GET con `setupAllowed:true`, poi setup completo con Kit.
    2. N3: `setupAllowed:false` e "Il vault non è ancora disponibile."
    3. Riavvia con la lista `' <idE> , <idN3> '`. Su N3 clicca "Riprova".
    4. Riavvia con un id sbagliato di un carattere. Su N3 clicca "Riprova".
    5. Come nel runbook, ripeti il passo 1 col SUPERADMIN dev. Prima del setup apri `/admin/vault-bench` e annota `DEFAULT_KDF.t` (3).
  - Atteso:
    - Il setup è consentito solo agli id esatti della lista, dopo il trim degli spazi.
    - Valore assente: chiuso. `'*'`: aperto a tutti.
  - Non deve: setup aperto a un id fuori lista; canary escluso per colpa degli spazi.

- [ ] **A.5 — Kill switch chiuso: chi è già READY continua a lavorare**
  - Prec.: R0 READY, con una nota sicura e una credenziale. Backend "chiuso".
  - Passi:
    1. R0 su /vault: la GET risponde `READY`. Si vede "Vault Bloccato", non "non disponibile".
    2. Sblocca, modifica la nota (PUT con envelope `nv3.`) e fai "Controlla ora".
    3. Rigenera il Kit dallo sheet.
    4. Cambia il PIN e sblocca col nuovo.
    5. Sul dispositivo B: login e /vault.
  - Atteso:
    - Sblocco, modifica, rigenerazione e cambio PIN funzionano.
    - Su B compare la richiesta del PIN, non il setup.
    - Il flag blocca solo POST `/keyring`.
  - Non deve: setupDisabled per un utente READY; 503 su `/unlock` o su PUT `/keyring`.

Dopo A.5 riavvia con `'*'`.

---

## B. Migrazione dal vault legacy

Ogni giro usa un utente L* nuovo con la Ricetta A. Esegui le voci prima di qualsiasi setup per quell'utente.

- [ ] **B.1 — Wizard completo su un seed misto: esito, titoli, finalize e campi derivati NULL sul DB**
  - Prec.: L1 con la Ricetta A (9 item, `legacyCount 9`). Prima di aprire /vault esegui Q1 e salva l'md5 di `credLock`. Un solo dispositivo, online.
  - Passi:
    1. Apri /vault: deve comparire "Aggiorna il tuo vault", non il setup "Configura il tuo Vault" (`vault.setupTitle`).
    2. Nuovo PIN e conferma = PIN1. Password = `password123`.
    3. PIN precedente 1 = `oldPin1`. Clicca "Aggiungi un altro PIN". PIN precedente 2 = `passPhrase9`. Non inserire `unknown77`.
    4. Spunta "Ho capito che senza PIN e Kit il mio vault è perso." e clicca "Avvia l'aggiornamento".
    5. Osserva gli step: "Invio delle modifiche in sospeso…", poi "Creazione delle chiavi del vault…", poi il Kit.
    6. Completa il Kit. Osserva "Ricifratura e controllo degli elementi…" con la barra "N di 9", poi "Chiusura…".
    7. Leggi il riepilogo e clicca "Fine".
    8. Esegui Q1, Q2, Q3, la query del keyring e Q5.
    9. Apri MK-TITLE-A, MK-TITLE-CV2, MK-TITLE-CPP, MK-TITLE-EMPTY e MK-TITLE-JSON e confronta i valori.
    10. Nella ricerca globale delle note cerca MK-BODY-A e MK-PW-CV2.
  - Atteso:
    - **Riepilogo**:
      - "7 elementi aggiornati e verificati." (A, C, T, CV2, CPP, EMPTY, JSON);
      - "1 elementi sono troppo grandi per essere cifrati e restano in sola lettura..." (`vault.migrateTooLarge`);
      - "1 credenziali sono bloccate con un PIN precedente..." (`vault.migrate.lockedSummary`), con i campi dei PIN precedenti e "Riprova".
    - **Q1**:
      - i 7 migrati hanno `head nv3.0.`, title `''`, `isEncrypted true`, e `st_null`, `y_null`, `sv_empty` tutti true;
      - `noteTrash` resta `isTrashed`;
      - `credLock` ha lo stesso md5 di prima e title `MK-TITLE-LOCK`;
      - `big` resta in chiaro.
    - **Q2** = 2.
    - **Q3**: `plain_v` = 0 sui migrati (prima noteA aveva almeno 1 versione). Le versioni in chiaro di `big` e `lock` restano.
    - **Keyring**: `READY`, `migrationState IN_PROGRESS`. Non arriva a DONE perché `legacyCount` è maggiore di 0 (§12.7).
    - **Q5**: `vault.keyring.created`, poi `vault.migrate` con ok 7, poi `vault.finalize`.
    - Titoli decifrati in lista e valori identici. La credenziale vuota si apre con i campi vuoti.
    - Ricerca globale: nessun risultato dal vault.
    - In Network: 1 POST `/keyring` 201, `/vault/items` paginato, `/vault/migrate`, `/vault/items {ids}`, `/vault/finalize`. Tutte con `no-store`.
  - Non deve: NoteVersion in chiaro su id finalizzati; `searchText` o `searchVector` valorizzati; la credenziale bloccata modificata (nemmeno il title); il Kit prima del 201; titoli "Senza titolo" dopo il reconcile.

- [ ] **B.2 — Nessun plaintext residuo sul dispositivo dopo la migrazione**
  - Prec.: subito dopo B.1, sullo stesso profilo, senza reload.
  - Passi:
    1. Subito dopo "Fine", esegui S-DUMP con gli aghi MK-BODY-A, MK-BODY-C, MK-PW-CV2, MK-PW-CPP, MK-TITLE-A. Annota lo store e il campo di ogni ago trovato (per esempio `searchText`).
    2. Controlla `vault-storage`: niente `pinHash`, niente plaintext.
    3. Ricarica online, sblocca e attendi 10-20 s (pull). Ripeti S-DUMP.
    4. Controlla Dexie `notes` (righe isVault) e `syncQueue`.
  - Atteso:
    - Dopo il reload e la pull restano solo MK-TITLE-LOCK, MK-TITLE-BIG e MK-BODY-BIG, cioè gli item rimasti legacy per scelta.
    - Le righe migrate hanno `nv3.` e title `''`.
    - Niente `pinHash`. Coda vuota.
  - Non deve: MK-BODY-* o MK-PW-* rimasti dopo la pull.
    - Da osservare: il reconcile non tocca `searchText`. Se MK-BODY compare solo nel primo dump, annotalo come residuo temporaneo.
    - Se resta anche dopo il reload online, è un difetto.

- [ ] **B.4 — Migrazione da 2 dispositivi in parallelo: 201 + 409, un solo keyring, nessuna perdita (accettazione 14-15)**
  - Prec.: L2 con la Ricetta A, oppure circa 30 note legacy con il seed di L.2 in ciclo. A e B loggati e fermi sul wizard.
  - Passi:
    1. Compila su entrambi: PIN1 su A, un PIN diverso su B (`q4Wm7Z`), vecchi PIN uguali, casella spuntata.
    2. Clicca "Avvia" su A. Appena A mostra il Kit, clicca "Avvia" su B.
    3. Su B compare "Questo vault è già stato creato su un altro dispositivo. Inserisci il PIN di quel dispositivo.". Prova `K7rQ2X` (errore, resti nella fase), poi PIN1 con "Sblocca e continua".
    4. Completa il Kit su A. Confronta i due riepiloghi e chiudi con "Fine" su entrambi. Su A fai "Controlla ora".
    5. Esegui Q1, Q3, la query del keyring e Q5. Conta le righe vault.
    6. Variante con un utente nuovo: "Avvia" su A e su B a meno di 1 s di distanza.
  - Atteso:
    - Una sola riga keyring (`READY`, `epoch 0`). B non vede mai il Kit.
    - Un solo `vault.keyring.created`.
    - Ogni lato conta nel proprio riepilogo gli item che ha inviato e verificato, compresi gli `already`. Ogni lato ne conta al massimo 7, la somma A+B può superare 7, e insieme coprono tutti i 7 migrabili.
    - Ogni item migrabile è `nv3` una volta sola. Nessuna versione in chiaro. md5 di `credLock` invariato. Conteggio delle righe uguale a quello iniziale.
    - Il PIN di B non sblocca nulla.
    - Nessun riepilogo mostra errori "invalid".
    - `migrationState`: DONE se non resta nulla di legacy.
    - "Controlla ora": "Tutto aggiornato."
  - Non deve: un secondo keyring; "Il server ha rifiutato un elemento"; "(copia in conflitto)"; il Kit su B; item rimasti legacy oltre a lock e big.

- [ ] **B.8 — Interruzione dopo /migrate e prima di /finalize: la ripresa allo sblocco cancella le versioni in chiaro**
  - Prec.: L5. Breakpoint XHR su `/vault/finalize`.
  - Passi:
    1. Fai il wizard fino alla fine del Kit: il giro si ferma alla prima `/finalize`.
    2. Con il debugger in pausa esegui Q3 e la query del keyring (`plain_v` maggiore di 0, `IN_PROGRESS`).
    3. Chiudi la SCHEDA senza riprendere.
    4. Riapri /vault, togli il breakpoint e sblocca.
    5. Attendi 5-15 s, poi esegui Q3, Q2 e la query del keyring. Guarda il banner e apri due item.
  - Atteso:
    - Compare la schermata di sblocco, non il wizard (il keyring è READY).
    - Dopo lo sblocco `plain_v` = 0 per gli id già `nv3` (reconcile, `finalizeItems`).
    - Il banner mostra un `legacyLeft` uguale a residui + lock + big. Il resume completa.
    - Valori identici al seed.
  - Non deve: versioni in chiaro rimaste su note `nv3` dopo uno sblocco online; envelope riscritti.
  - Limite: il reconcile non finalizza una NOTE il cui content non è un documento TipTap (`body.type` diverso da `'doc'`).

---

## C. Setup nuovo

Usa gli utenti N* (Mario Rossi), con il backend su `'*'`.

- [ ] **C.2 — Policy del PIN (accettazione 4): tabella dei PIN rifiutati e accettati**
  - Prec.: N7 "Mario Rossi" (mario.rossi2@example.com) su /vault in stato NONE, con password e "Ho capito" compilati. Nessun rifiuto deve consumare il rate limit.
  - Passi: per ogni riga metti lo stesso valore in PIN e in Conferma, clicca "Crea Vault", leggi il testo `role=alert` e verifica in Network che NON parta una POST.

    | PIN | Atteso |
    |---|---|
    | `123456`, `abcdef`, `ab12c`, `ab12_!`, `àb12cd` | "Il PIN deve avere 6 caratteri, lettere e cifre, con almeno una di ciascuna." (`format`) |
    | `2024ab`, `k0512x` | "Evita le date, come i compleanni." (`date`) |
    | `qwer12`, `xabc9k`, `1qaz9m` | "Evita le sequenze, come 123456 o abcdef." (`sequence`) |
    | `a1a1a1`, `a1b2c3` | "Evita caratteri o blocchi ripetuti." (`repetition`, non `sequence`) |
    | `Marco1` | "Questo PIN è troppo comune. Scegline un altro." (`common`) |
    | `ross7k` | "Evita il tuo nome o dati personali." (`personal`) |
    | `k7Rq2x` / `k7Rq2X` | "I PIN non corrispondono" (`vault.pinMismatch`) |

    Poi:
    1. Un PIN non valido con una conferma diversa deve dare il messaggio della policy, non il mismatch.
    2. Dopo un rifiuto la password resta compilata.
    3. `k7Rq2x` su entrambi i campi viene accettato e compare il Kit. Completa la cerimonia.
    4. Blocca. Prova `K7rQ2X` ("PIN errato"), poi `k7Rq2x` (sblocca).
  - Atteso: ogni rifiuto ha la sua chiave e non parte nessuna chiamata al server. Lo sblocco distingue maiuscole e minuscole.
  - Non deve: POST per un PIN rifiutato; "Qualcosa è andato storto"; un PIN della tabella accettato.

---

## D. Kit di recupero

- [ ] **D.4 — Cerimonia abbandonata (reload, chiusura, Indietro, logout, rigenerazione): banner kitUnconfirmed**
  - Prec.: 5 utenti nuovi, oppure il DELETE del keyring fra un giro e l'altro.
  - Passi:
    1. **A, reload**: con il foglio del Kit aperto e `<userId>:kit` in `pending`, premi F5.
       - Si vede "Vault Bloccato" e il Kit non compare.
       - Sblocca: compare il banner ambra "Il Kit di recupero non è stato confermato: rigeneralo." con "Rigenera".
       - In Network c'è una GET `/keyring` in più (`checkPendingOnStart`), con `escrowHash` uguale al marker.
    2. "Rigenera": si apre "Impostazioni vault". Chiudi senza rigenerare, blocca e risblocca: il banner ricompare.
    3. "Rigenera", PIN, "Genera nuovo Kit", cerimonia: toast "Kit di recupero confermato". Blocca e risblocca: niente banner, niente marker.
    4. **B**: chiudi la scheda o il browser durante il foglio.
    5. **C**: Indietro del browser o gesto Android. Annota se esci da /vault.
    6. **D**: logout da un'altra scheda con il foglio aperto.
    7. **E**: reload durante la cerimonia di rigenerazione, quando la PUT è già riuscita (md5 dell'escrow cambiato).
  - Atteso:
    - In tutte le varianti il Kit non si ri-mostra mai.
    - Dopo lo sblocco c'è il banner, finché non rigeneri e confermi.
    - Dopo la conferma il marker sparisce e non torna.
  - Non deve: banner assente con il marker presente e l'hash uguale; banner rimasto dopo la conferma; uscita da /vault (variante C) senza banner.
  - Nota: non c'è `beforeunload` né una guardia sulla history: valuta se servono.

---

## E. Sblocco, lockout, blocco e auto-lock

- [ ] **E.4 — Lockout al 6° errore: testo, conto alla rovescia, PIN corretto rifiutato, scadenza**
  - Prec.: R2 con `failedAttempts=0`. Lo SMTP dev, se vuoi vedere l'email.
  - Passi:
    1. 6 PIN sbagliati diversi (`a1b2c9` … `f6a7b9`).
    2. SELECT (la query del keyring).
    3. 7° tentativo col PIN CORRETTO.
    4. F5. Guarda la schermata prima di scrivere, poi inserisci il PIN corretto.
    5. Controlla la mailbox e Admin, Log di Audit.
    6. `UPDATE "VaultKeyring" SET "lockedUntil"=(now() AT TIME ZONE 'UTC') + interval '70 seconds' WHERE ...`. Ricarica, invia un PIN e guarda il conto arrivare a zero.
    7. Allo zero, inserisci il PIN corretto.
  - Atteso:
    - Tentativi 1-6: "PIN errato", senza conto alla rovescia (il 6° è ancora un 403).
    - `failedAttempts=6`, `lockedUntil` = adesso + 15 min (UTC).
    - Il 7° non parte verso il server (c'è solo la GET). Compare in ambra "Troppi tentativi. Riprova tra 14:5x." (`vault.unlock.lockedFor`), con il campo disabilitato e i secondi che calano.
    - Dopo F5 il campo è attivo fino all'invio; poi il conto riappare.
    - Email "Vault bloccato temporaneamente - Notiq" con 6 tentativi. L'orario è in ISO "(UTC)": annota se è leggibile. Nel log c'è `vault.unlock.locked`.
    - Allo zero il campo si riattiva. Il PIN sblocca e azzera il contatore.
  - Non deve: PIN corretto che sblocca durante il blocco; conto rimasto dopo la scadenza; 500.
  - Limite: senza SMTP c'è solo il warn `vault lockout email failed`.

- [ ] **E.14 — Uscita dal vault con una modifica non ancora salvata (meno di 1 s): Indietro, Blocca, sidebar, telefono, offline**
  - Prec.: R1 sbloccato, online.
  - Passi:
    1. In "Segreto A" scrivi ` ZZ1` ed entro mezzo secondo premi la freccia Indietro (`common.back`). Riapri.
    2. Scrivi ` ZZ2` e premi subito il lucchetto "Blocca Vault" (`vault.lock`). Sblocca e riapri.
    3. Scrivi ` ZZ3` e clicca subito "Note" nella sidebar. Torna, sblocca, riapri.
    4. In "Banca A" metti la password `pw-uscita-2` e premi subito Indietro del browser.
    5. Telefono: scegli una voce dal drawer subito dopo aver scritto.
    6. Offline: scrivi ` ZZ4`, esci, torna e fai lo sblocco offline.
  - Atteso:
    - Uscire da /vault blocca il vault.
    - Tutti i valori sono presenti.
    - Dexie: `nv3`, title `''`. In coda c'è un UPDATE con l'envelope, che online arriva al server.
    - Nessun `[vault] pre-lock flush failed`, nessun `notes.saveFailed`.
  - Non deve: perdita dell'ultimo testo; plaintext in Dexie o nella coda; item con userId `'current-user'`.

- [ ] **E.16 — Logout con il vault sbloccato e una modifica pendente**
  - Prec.: R1 con offline ON, "Segreto A" aperta, online.
  - Passi:
    1. Scrivi ` LO1` e premi subito "Esci".
    2. Sulla pagina di login controlla `vault-storage`, `notiq-vault-device`, `syncQueue` e Cache Storage.
    3. Login, /vault, sblocca, attendi la push.
    4. Variante offline: scrivi ` LO2`, esci, poi login online e sblocco.
  - Atteso:
    - `byUser[R1]` resta (`READY`, `wrappedVkPin`), `pinHash` null. Share e deviceKey restano.
    - In coda c'è un UPDATE `nv3` con userId R1 e title `''`.
    - Dopo il login: "Vault Bloccato".
    - ` LO1` e ` LO2` sono presenti, e il server riceve l'envelope.
  - Non deve: chiamate REST del flusher (niente 401 al logout); cache o share cancellati; item `'current-user'`.

---

## F. Uso quotidiano e invarianti del plaintext

Usa aghi univoci: TITOLO-SEGRETO-0n, CORPO-SEGRETO-0n, PW-SEGRETA-0n.

- [ ] **F.1 — Nota sicura nuova: titolo e corpo mai in chiaro (UI, Dexie, coda, rete, DB)**
  - Prec.: R1 sbloccato.
  - Passi:
    1. "+" (`Nuova Nota Sicura`).
    2. Titolo TITOLO-SEGRETO-01, corpo CORPO-SEGRETO-01, attendi 3 s.
    3. Controlla le POST e PUT `/api/notes`, Dexie `notes` e `syncQueue`, S-DUMP, Q1 e l'INVARIANTE.
    4. F5 e sblocca.
  - Atteso:
    - POST: title `''`, `content nv3.<epoch>.<iv16>.<ct>`, `isVault:true`, `isEncrypted:true`, `noteType:'NOTE'`.
    - PUT: solo content e un baseHash di 64 caratteri esadecimali, senza title.
    - Dexie: title `''`, `nv3`, `vaultBaseHash`, `synced`. Coda vuota.
    - S-DUMP: false. SQL: title `''`, `st_null` e `y_null` true, INVARIANTE = 0.
    - Dopo il reload il titolo si vede decifrato.
  - Non deve: aghi in un payload, in Dexie, in localStorage o nel DB; 422; `[noteService] scrittura vault rifiutata`.

- [ ] **F.14 — "Trasforma in Kanban o Task list" da una nota vault: plaintext al server**
  - Prec.: una nota con un elenco "VOCE-SEGRETA-1" e "VOCE-SEGRETA-2".
  - Passi:
    1. Seleziona l'elenco e premi il tasto destro. Controlla anche la toolbar secondaria (`editor.transform.toKanban` / `toTaskList`).
    2. Se ci sono, trasforma in Kanban su una nuova board.
    3. SQL: ricerca dell'ago `%VOCE-SEGRETA%`.
  - Atteso:
    - Per l'invariante, le trasformazioni NON devono essere disponibili.
    - **Corretto in `41df578` (23/10).** Nel vault il menu contestuale mostra solo taglia, copia e incolla. Ctrl+Shift+K/L non fa nulla. Il pannello scorciatoie non mostra le righe Kanban e Task list.
    - Controprova su una nota NORMALE: le due voci e le scorciatoie ci sono ancora.
  - Non deve: testo del vault in altre tabelle.

- [ ] **F.16 — Credenziale: campi cifrati, metadati del sito, generatore**
  - Prec.: R1 sbloccato.
  - Passi:
    1. "Nuova Credenziale".
    2. Titolo TITOLO-SEGRETO-03, URL `https://example.com`, poi esci dal campo.
    3. Utente USER-SEGRETO-03@example.com. Password generata col fulmine, "Usa", poi aggiungi `-PW-SEGRETA-03` in coda.
    4. Note NOTE-SEGRETE-03, attendi 3 s. Non cliccare "Usare … come titolo?".
    5. Network e S-DUMP con i 4 aghi. SQL.
  - Atteso:
    - POST e PUT solo con `nv3`, title `''`, `noteType 'CREDENTIAL'`.
    - S-DUMP: false. La card mostra titolo, dominio e il badge "Credenziale".
    - SQL: `searchText` NULL.
    - Accettato, da confermare soltanto: l'URL in chiaro nelle GET `/api/url-metadata?url=` e `/screenshot` (e nei log del backend se il fetch fallisce), più la richiesta a `icons.duckduckgo.com`.
    - Annota l'eventuale "Salvare la password?" di Chrome.
  - Non deve: username, password o note in un URL, in un payload o in uno storage.

---

## H. Multi-device, sync e conflitti

Per ogni scenario: A in una finestra normale, B in incognito, stesso utente. Usa note nuove con un titolo univoco. "Controlla ora" si trova in Impostazioni vault (`vault.settings.checkButton`). Il reconcile parte con: sblocco online, evento online, chiusura di una nota (se online), "Controlla ora". La push parte quando cambia la coda e con il tick di 30 s. La CAS fallita appare come PUT 422 `errors.vault.conflict`.

- [ ] **H.1 — Conflitto vero: A offline, B online, editor di A chiuso. Una copia, nessuna perdita**
  - Prec.: nota S01-nota con corpo `zero`, già in sync su A e su B.
  - Passi:
    1. A: apri S01-nota (`zero`) e torna Indietro. Vai Offline.
    2. A: titolo "S01-nota A", corpo `A-offline`, 3 s, Indietro. `nq` mostra `updated`, un UPDATE pending, base invariata.
    3. B: apri, scrivi `B-online`, 3 s, Indietro. `sq(['ID'])`: l'hash è cambiato.
    4. A: torna online e attendi fino a 30 s.
    5. A: apri l'originale e la copia.
    6. "Controlla ora" 2 volte, poi reload e sblocco. Ripeti una volta in inglese.
  - Atteso:
    - In lista: "S01-nota" (con `B-online`) e "S01-nota A (copia in conflitto)" (con `A-offline`).
    - `sq`: 2 item. POST della copia con title `''`. Di norma nessuna PUT dell'originale.
    - `nq`: `synced`, base = hash del server, `sent=[]`, coda vuota.
    - "Tutto aggiornato.". Una sola copia anche dopo il reload.
    - In inglese il suffisso è "(conflict copy)".
  - Non deve: server con il contenuto di A; più copie; `A-offline` perso; title in chiaro.
  - Da osservare: se vedi una PUT 422 senza copia, la push ha battuto il reconcile e la nota è in LATER per `listSig` (backlog di HANDOFF §4.2). Si sblocca aprendo e chiudendo la nota o con "Controlla ora". Annotalo.

- [ ] **H.2 — Variante con editor aperto (flake noto del test 1): A scrive di nuovo durante il conflitto**
  - Prec.: la credenziale S02-cred con `pw-0`. B la apre e la lascia aperta. Poi ripeti con una nota sicura.
  - Passi:
    1. A offline: `pw-A-1`, 3 s, form aperto.
    2. B: `pw-B-1`, 3 s.
    3. A online, fino a 40 s: PUT 422 e banner "1 modifiche non sincronizzate" (`sync.failed`).
    4. A, sempre col form aperto: `pw-A-2`, 5 s. `sq` è ancora sull'hash di B.
    5. Prima di chiudere: `nq` e `navigator.locks.query()`. Salva l'output.
    6. Indietro, 10 s. Poi `nq` e `sq`.
    7. Apri la copia (`pw-A-2`) e poi l'originale (`pw-B-1`).
    8. Ripeti 5 volte, variando i tempi:
       - Indietro meno di 1 s dopo `pw-A-2`;
       - PUT in volo con latenza di 3000 ms;
       - `pw-A-2` prima che arrivi il 422.
  - Atteso:
    - Originale (server e Dexie) = `pw-B-1`.
    - 1 copia CREDENTIAL con `pw-A-2`. Coda vuota, banner sparito.
  - Non deve: `pw-A-2` mostrato anche sull'originale; PUT 2xx con il contenuto di A; una seconda copia; una copia con `pw-A-1`.
  - Se l'hash di riga dell'originale è uguale a quello del server, il difetto è di UI (ri-decifratura del form o liveQuery vecchia). Se è diverso, cerca una PUT o POST tardiva sull'originale, `[vaultReconcile] nota lasciata invariata`, e un UPDATE ricomparso dal cleanup del form.
  - Nota: l'E2E corrispondente è instabile 1 volta su 6.

- [ ] **H.5 — Rete che cade a metà reconcile e scheda chiusa subito dopo la copia**
  - Prec.: conflitto pronto come in H.1 passi 1-3, editor di A chiuso, A offline. Profilo di throttling "Notiq lenta".
  - Passi:
    1. "Notiq lenta" (online).
    2. Appena compare la POST `/vault/items` pending: Offline. Poi `nq` e la lista.
    3. Di nuovo "Notiq lenta". Appena compare la copia in lista, con la sua POST pending, premi Ctrl+W.
    4. Riapri senza throttling, sblocca, attendi 30 s. Poi `nq`, `sq`, "Controlla ora".
  - Atteso:
    - Passo 2: nessuna modifica locale (il giro si interrompe).
    - Alla fine: 2 item, una sola copia, coda vuota. La CREATE della copia arriva al server una volta sola, con lo stesso id salvato in Dexie.
  - Non deve: due copie; copia solo locale; originale adottato senza copia; errori visibili.

---

## I. Spostamenti dentro e fuori dal vault

- [ ] **I.1 — Sposta DENTRO una nota normale: testo appena scritto incluso, cifratura e versioni**
  - Prec.: vault sbloccato in questa scheda. Una nota normale non condivisa, senza allegati, con più di 150 caratteri e almeno 1 versione.
  - Passi:
    1. Scrivi `MK-LAST-TYPED` ed entro 1 s scegli "Aggiungi al Vault" (su mobile dal menu "altro"). Senza condivisione non c'è dialog di conferma.
    2. Durante "Spostamento nel vault…" prova a scrivere.
    3. Attendi il toast.
    4. In /vault apri la nota.
    5. Q6, Dexie e S-DUMP.
  - Atteso:
    - Editor in sola lettura durante lo spostamento. Toast "Aggiunto al Vault". La nota sparisce da /notes.
    - Il contenuto comprende `MK-LAST-TYPED` e il titolo originale.
    - Q6: `isVault`, `isEncrypted`, title `''`, `nv3`, `searchText` e `ydocState` NULL, `isPublic false`, nessuna versione in chiaro.
    - Dexie: `nv3`, title `''`, `searchText ''`. In coda nessun item per la nota.
    - Network: PUT del testo, GET, PUT `{isVault:true,title:'',content:'nv3...',baseHash}`, POST `/vault/items`, POST `/vault/finalize`.
  - Non deve: testo perso; PUT con `isVault` e contenuto in chiaro; plaintext residuo.

- [ ] **I.2 — Sposta DENTRO una nota condivisa e pubblica con collaborazione live**
  - Prec.: A con il vault READY. C ha accettato la condivisione. La nota è pubblica (annota il link). Entrambi la tengono aperta.
  - Passi:
    1. C scrive `MK-FROM-C` e attende circa 1 s.
    2. A: "Aggiungi al Vault". Compare "Avviso Importante" con "Aggiungendo questa nota al Vault verranno rimossi tutti i link pubblici e gli accessi condivisi. Sei sicuro?". Conferma.
    3. C continua con `MK-AFTER-C`.
    4. Apri il link pubblico in incognito.
    5. C ricarica le note condivise.
    6. A apre la nota nel vault. Q6.
  - Atteso:
    - C'è `MK-FROM-C` (flush del doc live). Non c'è `MK-AFTER-C`: è un residuo accettato.
    - Il link pubblico non mostra più la nota. C perde la nota e la sua WS si chiude.
    - Q6: `SharedNote` 0, `isPublic false`, `shareId` NULL, `ydocState` e `searchText` NULL, nessuna versione in chiaro.
    - Se il flush fallisce: "La nota è cambiata sul server. Riprova." e nessuno spostamento.
  - Non deve: `MK-FROM-C` perso; salvataggi di C dopo lo spostamento.

- [ ] **I.8 — Togli dal vault: chiaro sul server, ricerca, cronologia, dispositivo B offline**
  - Prec.: A e B READY. S con `MK-OUT-T` e `MK-OUT-B` (più di 150 caratteri).
  - Passi:
    1. A: "Rimuovi dal Vault", dialog "Togli dal vault" ("La nota verrà salvata non cifrata fra le note normali. Continuare?"), "Conferma".
    2. A: /notes, ricerca globale, cronologia. Q6.
    3. B: 30-60 s online, poi Offline e apri S.
    4. Online, riapri.
    5. Variante: offline su S vuota, scrivi `MK-B-OFFLINE`, torna online. Q6 e cronologia.
  - Atteso:
    - "Rimosso dal Vault". S è in /notes e la ricerca la trova. Nessuna versione `nv3` nella cronologia.
    - Q6: in chiaro, `searchText` presente.
    - B offline: corpo vuoto (backlog noto). Online: completo.
    - Variante: `MK-OUT-B` non deve sparire dal server. O si fonde, o si recupera dalla cronologia (da osservare).
  - Non deve: item envelope in coda dopo il 200; `nv3` su una nota normale.

---

## J. Impostazioni vault e cambio PIN

- [ ] **J.1 — Cambio PIN dal VaultSettingsSheet: percorso felice, nessun segreto in rete, Kit invariato**
  - Prec.: R1 sbloccato, online. Annota `rev`, l'md5 dell'escrow e l'md5 del `pinSalt`.
  - Passi:
    1. Ingranaggio. In ordine: "Cambia PIN" (3 campi), la nota "Un dispositivo che resta offline accetta il vecchio PIN finché non torna online.", poi "Kit di recupero", poi "Controlla il vault".
    2. Da PIN1 a PIN2, con conferma.
    3. Network: GET, POST `/unlock`, PUT `/keyring` 200 `{rev:N+1}`. Cerca PIN1 e PIN2 nei body con Ctrl+F.
    4. Toast "PIN cambiato", campi vuoti.
    5. Blocca. Prova PIN1, poi PIN2.
    6. Apri la nota e la credenziale.
    7. SQL, `vault-storage`, `pending`.
  - Atteso:
    - PIN1: "PIN errato". PIN2 sblocca e decifra.
    - `rev` +1, `pinSalt` diverso, escrow identico (il Kit resta valido), `failedAttempts` 0.
    - Cache con il nuovo `pinSalt`. Niente `<userId>:pin`.
  - Non deve: PIN nei body o in Console; Kit mostrato; copie in conflitto.

- [ ] **J.5 — Cambio PIN sul PC: B offline accetta il vecchio PIN, online il nuovo**
  - Prec.: R1 con PIN1. B con offline ON, sbloccato una volta online. Annota su B `pinSalt`, `rev` e i primi byte di `shareEnc`.
  - Passi:
    1. B: blocca e va offline.
    2. PC: da PIN1 a PIN2.
    3. B offline: PIN2, poi PIN1.
    4. B offline: nella nota scrivi `offline-B-1` (in coda come `nv3`). Blocca e usa PIN1.
    5. B online: attendi che la coda si svuoti.
    6. PC: apri la nota.
    7. B online: blocca, PIN1, poi PIN2.
    8. B: cache, `shares` e GET keyring.
    9. B offline: PIN1, poi PIN2.
    10. Riporta il PIN a PIN1.
  - Atteso:
    - B offline: PIN2 dà "PIN errato" (nessun lockout, contatore invariato), PIN1 sblocca.
    - La coda si svuota senza `vault:conflict`. Sul PC c'è `offline-B-1`, nessuna copia.
    - B online: PIN1 dà "PIN errato" (+1), PIN2 sblocca. `pinSalt` e `rev` uguali al server, `shareEnc` riscritto con epoch invariata.
    - B di nuovo offline: PIN1 errato, PIN2 sblocca.
  - Non deve: edit perso o duplicato; copia per il solo cambio PIN; lockout dai tentativi offline; share cancellato.

- [ ] **J.7 — "Rimuovi vault da questo dispositivo": guardia su righe e coda, poi rimozione completa**
  - Prec.: un utente dedicato su B (Edge), offline ON. Lo stesso account sul PC.
  - Passi:
    1. B offline: modifica una nota (`non-sync-1`) e crea una credenziale.
    2. Vai su Impostazioni (il vault si blocca). In coda ci sono almeno 2 item.
    3. "Rimuovi da questo dispositivo".
    4. Online: attendi che la coda si svuoti.
    5. "Rimuovi", poi "Annulla".
    6. "Rimuovi" e conferma.
    7. Controlla Dexie, `vault-storage` e `notiq-vault-device`.
    8. Sezione Vault.
    9. Offline su /vault, poi online col PIN.
    10. PC: verifica le modifiche.
  - Atteso:
    - Passo 3: testo rosso "2 modifiche del vault non sono ancora sincronizzate: collegati e attendi la sincronizzazione prima di rimuovere." (`vault.settings.removeBlocked`; il numero conta le entità). Nessun dialog.
    - Passo 6: toast "Vault rimosso da questo dispositivo".
    - Nessuna riga `isVault` dell'utente. Una pull successiva può riportare metadati ed envelope, ed è normale.
    - Niente `byUser`, `deviceKeys`, `shares` né `pending` dell'utente.
    - Sezione Vault: solo la spiegazione e il link.
    - Offline: VaultOfflineNotice, mai il setup. Online lo sblocco funziona.
    - Il PC ha tutte le modifiche.
  - Non deve: rimozione con item in coda; dati persi; rimozione di note di un altro utente dello stesso browser.

---

## K. Build di prod e cache del Service Worker

Si lavora su :4173, con la build di "Build di prod con il Service Worker".

- [ ] **K.1 — api-cache senza /api/vault/ né /api/notes/<id>**
  - Prec.: login, una nota normale, una nota sicura con TITOLO-SEGRETO-SW e CORPO-SEGRETO-SW, una credenziale.
  - Passi:
    1. Service Workers: "activated and running".
    2. Naviga: lista note, una nota normale, Impostazioni, /vault (sblocco online), nota sicura, credenziale, "Controlla ora", cronologia.
    3. Cache Storage, `api-cache`: elenca gli URL.
    4. Apri `/api/notes?...` e guarda le righe vault.
    5. S-DUMP con TITOLO-SEGRETO-SW, CORPO-SEGRETO-SW, `serverShare`, `wrappedVkPin`.
    6. Header di GET `/api/vault/keyring` e di un 403 (PIN errato).
  - Atteso:
    - Nessuna voce `/api/vault/*` né `/api/notes/<id>...`.
    - `/api/notes?...` è ammessa, ma le righe vault hanno title `''` e niente content.
    - S-DUMP: false.
    - Le risposte `/api/vault/*` non arrivano dal "(ServiceWorker)". `no-store` anche sul 403.
  - Non deve: plaintext in qualsiasi cache.

- [ ] **K.2 — Logout e sblocco online svuotano api-cache**
  - Prec.: stessa build :4173 di K.1, utente loggato con cache popolata.
  - Passi:
    1. Logout, poi Refresh Caches sulla pagina di login.
    2. Login, ripopola la cache, sblocco online e subito Refresh.
  - Atteso:
    - Dopo il logout `api-cache` non c'è. Se rinasce per una GET della pagina di login, deve contenere solo endpoint pubblici: annota l'URL.
    - Allo sblocco online viene cancellata.
  - Non deve: liste dell'utente precedente.
  - Da osservare: la gara fra il purge e una GET NetworkFirst in volo.

---

## L. Concorrenza su DB dev

- [ ] **L.1 — 2 POST /api/vault/keyring paralleli: 201 + 409, una sola riga**
  - Prec.: C1 senza keyring, su /settings (non /vault). Backend `'*'`. Dopo il test l'account è inutilizzabile.
  - Passi:
    1. In Console, con la password vera al posto di `PASSWORD_DELL_ACCOUNT`:
       ```js
       (async function () { var tok = JSON.parse(localStorage.getItem('auth-storage')).state.token; function b64u(buf) { var b = new Uint8Array(buf), s = ''; for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).split('+').join('-').split('/').join('_').split('=').join(''); } function rnd(n) { return b64u(crypto.getRandomValues(new Uint8Array(n))); } var kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']); var spki = b64u(await crypto.subtle.exportKey('spki', kp.publicKey)); function post() { var body = { expectedEpoch: 0, password: 'PASSWORD_DELL_ACCOUNT', kdf: 'argon2id', kdfParams: { m: 65536, t: 3, p: 1 }, pinSalt: rnd(16), wrappedVkPin: rnd(60), authKey: rnd(32), serverShare: rnd(32), vkSigPub: spki, wrappedVkSigKey: rnd(100), escrowBlob: rnd(60), sealedRootShare: rnd(157), rootKeyId: 'rk_68a265761e7e37c7', userShareUnderVk: rnd(48) }; return fetch('/api/vault/keyring', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify(body) }).then(function (r) { return r.text().then(function (t) { return r.status + ' ' + t; }); }); } console.log(await Promise.all([post(), post()])); })();
       ```
    2. SQL: `SELECT count(*), max(status::text), max(rev) FROM "VaultKeyring" WHERE "userId"='<id>';` e l'audit `vault.keyring%`.
    3. Rilancia lo snippet una terza volta.
  - Atteso:
    - `201 {"status":"READY","epoch":0,"rev":0}` e `409 …errors.vault.alreadySetup`, in ordine qualsiasi.
    - 1 riga, `rev 0`, un solo `vault.keyring.created`.
    - Terzo giro: due 409.
  - Non deve: due 201; 500 (P2002 non gestito); `rev 1`.

- [ ] **L.2 — /api/vault/migrate dello stesso item da 2 client in parallelo**
  - Prec.: C2 senza keyring. Prima la nota legacy, poi il keyring.
  - Passi:
    1. Seed:
       ```js
       (async function () { var tok = JSON.parse(localStorage.getItem('auth-storage')).state.token; var H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }; var nbs = await (await fetch('/api/notebooks', { headers: H })).json(); var nb = (Array.isArray(nbs) ? nbs : nbs.notebooks)[0].id; var doc = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'legacy concorrenza ' + 'x'.repeat(200) }] }] }); var id = crypto.randomUUID(); var r = await fetch('/api/notes', { method: 'POST', headers: H, body: JSON.stringify({ id: id, notebookId: nb, title: 'Legacy CONC', content: doc, isVault: true, noteType: 'NOTE' }) }); console.log(r.status, id); })();
       ```
    2. Lancia lo snippet di L.1 con la password di C2. Controlla `migrationState IN_PROGRESS`.
    3. SQL: conta le NoteVersion (V0).
    4. Due migrate in parallelo:
       ```js
       (async function () { var tok = JSON.parse(localStorage.getItem('auth-storage')).state.token; var H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }; function rnd(n) { var b = crypto.getRandomValues(new Uint8Array(n)), s = ''; for (var i = 0; i < n; i++) s += String.fromCharCode(b[i]); return btoa(s).split('+').join('-').split('/').join('_').split('=').join(''); } var it = (await (await fetch('/api/vault/items', { method: 'POST', headers: H, body: '{}' })).json()).items[0]; function mig() { var env = 'nv3.0.' + rnd(12) + '.' + rnd(32); return fetch('/api/vault/migrate', { method: 'POST', headers: H, body: JSON.stringify({ items: [{ id: it.id, baseHash: it.contentHash, noteType: it.noteType, content: env }] }) }).then(function (r) { return r.json().then(function (j) { return { env: env, res: j }; }); }); } console.log(JSON.stringify(await Promise.all([mig(), mig()]))); })();
       ```
    5. SQL sulla nota e sulle versioni.
    6. Rilancia lo snippet del passo 4.
  - Atteso:
    - Un `ok` e un `already` o `conflict`.
    - Content = envelope del vincitore, title `''`, `isEncrypted`, `searchText` e `ydocState` NULL.
    - NoteVersion = V0 + 1.
    - Secondo lancio: due `already`.
  - Non deve: due `ok`; content del perdente; V0 + 2; 500.

---

## N. Chiusura in dev

- [ ] **N.1 — Controllo finale: nessuna NoteVersion non nv3 su note vault già cifrate**
  - Prec.: tutti gli utenti di prova sbloccati online almeno una volta dopo l'ultimo spostamento.
  - Passi:
    1. Q7.
    2. Q3 per ogni utente.
    3. Le righe con `plain_v` maggiore di 0 sono ammesse solo su note ancora legacy, e sulla RAW della variante F di B.16 (limite noto).
    4. Se una nota `nv3` ha ancora versioni in chiaro: sblocca online, attendi e rifai Q3.
  - Atteso: Q7 = 0, salvo le eccezioni del passo 3. Dopo lo sblocco ogni nota `nv3` con un documento valido ha `plain_v` = 0.
  - Non deve: versioni non `nv3` su note `nv3` con documento valido.

Pulizia dev (non BLOCCANTE, N.2): lascia il backend su `'*'` per gli E2E, fai Unregister del SW e Clear site data su :4173, rimuovi il worktree `main` se l'hai creato.

---

## Solo in prod (durante il deploy)

Voci N.3-N.6. Le query in prod le lanci tu.

- [ ] **N.3 — Passi 1-3 del runbook: test locali, SQL pre-deploy, .env chiuso**
  1. In locale, per backend e frontend: `test`, `tsc` (frontend: `npx tsc -p tsconfig.app.json --noEmit`), `lint` e `build`. Poi gli E2E completi più i 5 nuovi del vault, T6 verde, T25 con gli SPKI reali.
  2. Pre-deploy, in prod:
     - `SELECT count(*) FROM "VaultKeyring";` → 0;
     - `SELECT "userId", count(*) FROM "Note" WHERE "isVault" AND content NOT LIKE 'nv3.%' GROUP BY 1;` → annota;
     - `SELECT n.id FROM "Note" n WHERE n."isVault" AND EXISTS (SELECT 1 FROM "Attachment" a WHERE a."noteId"=n.id);` → note vault con allegati (D3);
     - `SELECT "userId", count(*) FROM "Note" GROUP BY 1 HAVING count(*) > 50;` → utenti toccati da T0 (A.2);
     - `SELECT count(*) FROM "Note" WHERE "isVault" AND "noteType"='NOTE' AND content NOT LIKE '{%';` → limite di B.8 e B.16;
     - controllo dei lock su `"User"`.
  3. `.env` di prod: `VAULT_SETUP_USERS=` vuoto o assente.
  4. Al primo deploy annota il timestamp `ts1` di `_backup_<ts1>`. Il rollback pre-P2 si fa sempre da `_backup_<ts1>`, mai dal backup del secondo deploy.
  - Non deve: deploy con test rossi; `VAULT_SETUP_USERS` valorizzato prima del passo 8; rollback da un backup che contiene già un `dist` P2.

- [ ] **N.4 — Passi 4-5 del runbook: il bundle servito è davvero quello nuovo**
  - Prec.: deploy fatto con `VAULT_SETUP_USERS` vuoto. Annota `ts1`, lo SHA256 dello zip e il nome di `index-*.js`.
  1. `curl.exe -s https://notiq.epartner.it/ | findstr index-`: deve coincidere con il pacchetto.
  2. `curl.exe -sI https://notiq.epartner.it/assets/NOME_INDEX.js | findstr /i content-type`: JavaScript, non text/html.
  3. Ctrl+F5: SW nuovo attivo, index nuovo caricato.
  4. `/sw.js`: stesso controllo di K.4 (predicato inline in `sw.js`, precache con i chunk del bench e del Worker).
  5. GET keyring: `no-store` anche attraverso IIS e ARR, `setupAllowed false` per tutti.
  6. `api-cache-purged` = versione nuova, cache svuotata.

- [ ] **N.5 — Passo 6: benchmark Argon2id su iPhone, Safari e PWA**
  - Prec.: iPhone 12 o più recente (il più vecchio che hai), batteria carica, schermo sempre acceso, SUPERADMIN.
  1. Safari su `/admin/vault-bench`: annota modello e iOS. Il riquadro "insecure" non deve comparire.
  2. "Avvia" (t = 3..10 a 64 MiB). Fai uno SCREENSHOT dopo ogni t: un OOM ricarica la pagina e il bench non salva nulla.
  3. "Copia" (in alternativa copia dal campo) e incolla il JSON nell'addendum D4.
  4. Installa la PWA e rifai la misura: `standalone true`.
  5. Scegli il t massimo con p95 a caldo di 1,5 s al massimo e sblocco a freddo di 2 s al massimo, sia in Safari sia nella PWA. Il minimo è 3.
  6. `SELECT count(*) FROM "VaultKeyring";` deve dare 0.
  - Esiti:
    - t = 3: nessun intervento.
    - t più alto: secondo deploy con `DEFAULT_KDF.t` e `KDF_T_MIN` nello STESSO commit, poi rifai N.4.
    - OOM o vincoli violati già a t = 3: STOP e rollback del dist da `_backup_<ts1>`.

- [ ] **N.6 — Passo 8: canary SUPERADMIN (punto di non ritorno)**
  - Prec.: `VAULT_SETUP_USERS=<ID_SUPERADMIN>` nel .env e `pm2 restart notiq-backend`.
  1. Il bench mostra `t` ed `entry` uguali a quelli del pacchetto.
  2. Wizard di migrazione e Kit completo. Salva il PDF in un posto sicuro.
  3. Query (le lanci tu):
     - `SELECT content ~ '^nv3\.' env, title='' t, "searchText" IS NULL s, "ydocState" IS NULL y, count(*) FROM "Note" WHERE "userId"='<ID>' AND "isVault" GROUP BY 1,2,3,4;`
     - versioni non `nv3`;
     - `migrationState`, `rev`, md5 dell'escrow.
  4. Titoli decifrati. Apri 2 note e 2 credenziali.
  5. Telefono: offline ON, sblocco online, poi modalità aereo, riapertura della PWA e sblocco offline.
  6. Rigenera il Kit dal PC: l'escrow cambia.
  7. Opzionale: J.5 su un iPhone vero.
  8. Cache Storage su PC e telefono come in K.1. Logout come in K.2.
  - Atteso:
    - Tutto true, tranne gli item elencati dal wizard. Nessuna versione in chiaro.
    - `migrationState` DONE, oppure IN_PROGRESS spiegato da §12.7.
  - Non deve: rollback del dist dopo questo punto (si va di forward-fix, D6).
