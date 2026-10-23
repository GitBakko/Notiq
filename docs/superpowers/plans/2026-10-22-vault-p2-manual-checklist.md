# Checklist di verifica manuale: Vault v3 (P2), branch `feat/vault-p2`

Ambiente di partenza:
- backend su :3001, avviato con `VAULT_SETUP_USERS='*'` come variabile del processo;
- Vite su http://localhost:5173;
- DB `notiq-db` sulla porta 5433.

I testi attesi sono in italiano (`it.json`) e hanno la chiave i18n accanto. "Base" indica il codice su cui si fonda l'atteso. Se l'atteso non è certo, la voce dice "da osservare". Fra parentesi c'è l'ID della versione precedente (ex …).

---

## Indice

| Sezione | Contenuto | Voci | BLOCCANTI | Stima |
|---|---|---|---|---|
| P0 | Preparazione (non sono voci da spuntare) | 12 passi | – | 1 h – 1 h 30 |
| A | Utente senza keyring, kill switch, stati del Gate, pull completa | 9 | 5 | 2 h 30 |
| B | Migrazione dal vault legacy | 16 | 4 | 4 h 30 |
| C | Setup nuovo | 11 | 1 | 2 h |
| D | Kit di recupero | 9 | 1 | 2 h 30 (D.6 ha attese da 12 min) |
| E | Sblocco, lockout, blocco e auto-lock | 18 | 3 | 3 h 30 (E.12 ed E.13 hanno attese da 10-15 min) |
| F | Uso quotidiano e invarianti del plaintext | 23 | 3 | 3 h 30 |
| G | Offline | 5 | 0 | 1 h |
| H | Multi-device, sync e conflitti | 15 | 3 | 4 h |
| I | Spostamenti dentro e fuori dal vault | 11 | 3 | 2 h 30 |
| J | Impostazioni vault e cambio PIN | 9 | 3 | 2 h |
| K | Build di prod e cache del Service Worker | 5 | 2 | 1 h (build compresa) |
| L | Concorrenza su DB dev | 2 | 2 | 20 min |
| M | Telefono, mobile, dark mode, lingua | 7 | 0 | 3 h |
| N | Chiusura in dev e passi per la prod | 9 | 5 | dev 30 min; prod 3-5 h (finestra del runbook) |
| **Totale** | | **149** | **35** | **dev circa 33 h (4-5 giorni) + prod 3-5 h** |

Le stime sono indicative. Contano una persona sola, con gli account già pronti, e non contano le ripetizioni dopo un difetto.

---

## P0. Preparazione

### P0.1 Dove vanno le chiamate /api (da fare per primo)

- `frontend/.env` esiste, ma non l'ho letto.
- `api.ts:5` usa `VITE_API_URL`. Se manca, usa `http://localhost:3001/api`.
- Dopo il login apri Network e guarda l'host di una richiesta `/api/...` qualsiasi:
  - `localhost:5173` vuol dire che passa dal proxy di Vite (`VITE_API_URL=/api`);
  - `localhost:3001` vuol dire che la chiamata è diretta.
- Annota l'esito. Da questo dipendono P0.6 (telefono), E.9 (backend fermo) e M.1 (LAN).
- Gli snippet S-API e la Ricetta A usano `http://localhost:3001/api` e funzionano in entrambi i casi, perché il CORS accetta `localhost:5173` (`app.ts:54`).

### P0.2 Riavvio del backend e kill switch

- `VAULT_SETUP_USERS` viene letto a ogni chiamata (`vault.service.ts:158-161`), ma solo da `process.env`. Per cambiarlo serve un riavvio.
- Prima ferma il backend con Ctrl+C e controlla che la porta 3001 sia libera.
- Poi, in PowerShell, dalla cartella `D:\Develop\AI\Notiq\backend`:

| Stato | Comando |
|---|---|
| Aperto a tutti | `$env:VAULT_SETUP_USERS='*'; npm run dev` |
| Chiuso | `Remove-Item Env:VAULT_SETUP_USERS -ErrorAction SilentlyContinue; npm run dev` |
| Canary | `$env:VAULT_SETUP_USERS='<userIdA>'; npm run dev` |
| Lista con spazi | `$env:VAULT_SETUP_USERS=' <userIdA> , <userIdB> '; npm run dev` |
| Pepper non valido | `$env:VAULT_PEPPER_KEY='invalid'; $env:VAULT_SETUP_USERS='*'; npm run dev` (poi `Remove-Item Env:VAULT_PEPPER_KEY` e riavvio) |
| Pepper diverso ma valido (A.7) | `$env:VAULT_PEPPER_KEY=(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"); $env:VAULT_SETUP_USERS='*'; npm run dev` (poi `Remove-Item Env:VAULT_PEPPER_KEY` e riavvio) |

Avvertenze:
- In PowerShell `$env:X=''` **cancella** la variabile.
- `dotenv` non sovrascrive una variabile già presente nel processo. Con lo stato "chiuso", se `GET /api/vault/keyring` di un utente NONE risponde ancora `setupAllowed:true`, allora `backend/.env` contiene un valore di `VAULT_SETUP_USERS`. Controllalo tu: io non l'ho letto.
- Le variabili restano nella sessione PowerShell. A fine prova riavvia con `'*'` e con il pepper originale, perché gli E2E ne hanno bisogno.
- I rate limit stanno in memoria, sono per utente e si azzerano a ogni riavvio (`routes/vault.ts:92-143`, `app.ts:129`):
  - GET `/keyring`: 60 al minuto;
  - POST `/keyring`: 5 all'ora;
  - PUT `/keyring`: 10 all'ora (cambio PIN e rigenerazione del Kit insieme);
  - POST `/unlock`: 10 al minuto;
  - `/migrate`: 20 al minuto;
  - `/finalize`: 20 al minuto;
  - `/vault/items`: 60 al minuto.

### P0.3 Account

- **SUPERADMIN dev**: `superadmin@notiq.ai` / `superadmin`. Serve per gli inviti, per `/admin/vault-bench` e come canary dev.
- **Promuovere un altro utente**:
  - da Admin UI, oppure con `PUT /api/admin/users/<id>` e corpo `{"role":"SUPERADMIN"}` (`routes/admin.ts:72`);
  - oppure in SQL dev: `UPDATE "User" SET role='SUPERADMIN' WHERE email='...';`.
  - Dopo la promozione rifai il login.
- **Ricetta di creazione** (PowerShell; è la stessa di `e2e/helpers.ts:47-81` e `vault-helpers.ts:27-42`). Usa nome e cognome veri, per esempio "Mario Rossi": servono alla regola `personal` della policy del PIN.
  ```powershell
  $sa = Invoke-RestMethod -Method Post http://localhost:3001/api/auth/login -ContentType 'application/json' -Body '{"email":"superadmin@notiq.ai","password":"superadmin"}'
  $h = @{ Authorization = "Bearer $($sa.token)" }
  $code = (Invoke-RestMethod -Method Post http://localhost:3001/api/invites -Headers $h).code
  try { Invoke-RestMethod -Method Post http://localhost:3001/api/auth/register -ContentType 'application/json' -Body (@{email='mario.rossi1@example.com';password='password123';name='Mario Rossi';invitationCode=$code} | ConvertTo-Json) } catch {}   # lo SMTP può fallire: l'utente nasce lo stesso
  $u = (Invoke-RestMethod "http://localhost:3001/api/admin/users?search=mario.rossi1%40example.com" -Headers $h).users[0]
  Invoke-RestMethod -Method Put "http://localhost:3001/api/admin/users/$($u.id)" -Headers $h -ContentType 'application/json' -Body '{"isVerified":true}'
  $u.id
  ```
- **Quanti account servono.** Ogni setup consuma il keyring, e il keyring non si azzera dalla UI. Prepara circa 33 utenti e annota `email → userId → uso`:

| Gruppo | Uso | Quanti |
|---|---|---|
| N1…N13 | Setup nuovo e Kit (sezioni C e D), A.7. Vanno consumati. | 13 |
| L1…L9 | Legacy con la Ricetta A (sezione B), uno per giro. L9 per B.16. | 9 |
| LB | Legacy con la Ricetta B (bundle `main`): B.12, B.13 | 1 |
| R1 | Utente principale READY, sblocco offline ON, una nota sicura "Segreto A" e una credenziale "Banca A" (utente alice@example.com, password S3cret-Pass-42) | 1 |
| R2 | Solo per il lockout (sblocco offline OFF) | 1 |
| R3 | Prove con il dispositivo B | 1 |
| R0 | READY creato in anticipo, serve ad A.5 con il kill switch chiuso | 1 |
| C1, C2 | Concorrenza su DB (sezione L). Vanno buttati. | 2 |
| E_CANARY, F_ALTRO | Canary. F_ALTRO con almeno una nota vault legacy. | 2 |
| U25 | Utente senza keyring, con note normali (una con allegato, una condivisa) | 1 |
| U60 | Utente senza keyring con più di 60 note (A.2) | 1 |

- **Per rifare il setup con lo stesso utente** (solo in dev, e solo per utenti senza note vault):
  1. `DELETE FROM "VaultKeyring" WHERE "userId"='<id>';`
  2. Nel browser: DevTools, Application, Clear site data.

### P0.4 PIN di prova

- PIN1 = `x9Kp4M`. Passa la policy (`vault-helpers.ts:11`).
- PIN1 con maiuscole e minuscole invertite = `X9kP4m`.
- PIN errato = `K7rQ2X`.
- PIN2 = `m4Tz8q`. Non l'ho provato contro la policy: se la policy lo rifiuta, scegline un altro di 6 caratteri con lettere e cifre.
- PIN legacy per la Ricetta A: `oldPin1`, `passPhrase9` e `unknown77`. Non fornire mai `unknown77`, salvo in B.3.

### P0.5 Dispositivi e profili

- **A**: il profilo principale di Chrome su :5173.
- **B**: un secondo browser (Edge) o un secondo profilo Chrome, se lo storage deve sopravvivere alla chiusura. Per le prove da una sola sessione basta l'incognito.
- **T1 e T2**: due schede dello stesso profilo. Condividono Dexie e Web Locks. Le chiavi del vault invece sono per scheda.
- **Origine :4173** (vite preview): conta come un dispositivo nuovo, con storage separato.

### P0.6 Telefono e contesto sicuro

- WebCrypto, Web Locks, Service Worker e clipboard esistono solo in un contesto sicuro: https oppure localhost.
- **`http://IP-LAN:5173` non vale.** Vite non ha `server.host` (`vite.config.ts:123`): senza `--host` la pagina non si carica nemmeno.
- **Android** (consigliato): debug USB, poi una delle due strade:
  - `adb reverse tcp:5173 tcp:5173`;
  - oppure chrome://inspect, Port forwarding della 5173.
  - **La porta 3001** va inoltrata solo se P0.1 dice "diretto": in quel caso axios chiama `http://localhost:3001/api` (`api.ts:5`). Si fa con `adb reverse tcp:3001 tcp:3001` oppure con il Port forwarding.
  - Sul telefono apri http://localhost:5173.
  - Per la preview aggiungi `tcp:4173`.
  - DevTools remoti da chrome://inspect.
  - La modalità aereo porta `navigator.onLine` a false, ma non taglia il tunnel adb. L'offline vero si fa con Network Offline dei DevTools remoti. Con `adb reverse --remove-all` simuli il server irraggiungibile con `onLine` ancora true.
  - Alternativa: chrome://flags, "Insecure origins treated as secure" con `http://IP:5173`, più `npm run dev -- --host`. Funziona solo se P0.1 dice "proxy". Altrimenti il telefono chiama il proprio localhost:3001.
- **iPhone**: in dev non è praticabile. Servirebbero HTTPS, un tunnel e modifiche ad `allowedHosts`, cioè modifiche di config da decidere a parte. Rimanda alla prod (sezione N).
- Sonda in Console: `isSecureContext, !!crypto.subtle, !!navigator.locks, 'serviceWorker' in navigator` devono dare tutti true.

### P0.7 DevTools da tenere aperti

- **Network**: Preserve log; filtri `vault`, `notes`, `vault/items|api/notes`. Controlla l'header `Cache-Control: no-store` sulle risposte `/api/vault/*`, comprese quelle di errore (`routes/vault.ts:83-86`).
- **Application**:
  - Local Storage: `vault-storage` (`state.byUser[userId]`), `auth-storage`, `api-cache-purged`;
  - IndexedDB `notiq-vault-device`: store `deviceKeys`, `shares` e `pending` (chiavi `<userId>:kit` e `<userId>:pin`, `deviceKeyStore.ts:6-10,76`);
  - IndexedDB `NotiqDB` (`db.ts:188`): `notes`, `syncQueue`, `tags`;
  - Cache Storage; Service Workers.
  - La vista IndexedDB non si aggiorna da sola: usa il tasto refresh.
- **Request blocking** (Ctrl+Shift+P, "Show Request Blocking"):
  - pattern `*/api/*` oppure `localhost:3001/api/notes*`. Con il proxy, il pattern diventa `localhost:5173/api/notes*`;
  - equivale a `blockApi` degli E2E: il server risulta irraggiungibile con `navigator.onLine` ancora true, e l'evento online non scatta.
- **Throttling personalizzato** "Notiq lenta": latenza 4000 ms, 200 kbps. Usa anche Slow 3G.
- **Breakpoint XHR** (Sources, XHR/fetch Breakpoints): `vault/keyring`, `/vault/finalize`, `/vault/migrate`, `/notes/`. Axios usa XHR, quindi la pausa scatta prima dell'invio. Premi F8 per le pause che non interessano.

### P0.8 Snippet da Console (nella scheda dell'app, dopo il login)

```js
// userId e token
JSON.parse(localStorage.getItem('auth-storage')).state.user.id
JSON.parse(localStorage.getItem('auth-storage')).state.token
// keyring dal server (passa dal proxy di Vite)
fetch('/api/vault/keyring',{headers:{Authorization:'Bearer '+JSON.parse(localStorage.getItem('auth-storage')).state.token}}).then(r=>r.json()).then(console.log)
```

**S-DUMP**: cerca un ago (un plaintext, oppure il primo gruppo del Kit) in tutti gli storage del dispositivo. Atteso: `trovato=false` per ogni ago, e il conteggio `nv3.` maggiore di 0 quando ci sono item vault. Aprire `notiq-vault-device` lo crea vuoto se non esiste: non è un errore.
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

**S-API**: helper REST.
```js
const TOK = JSON.parse(localStorage.getItem('auth-storage')).state.token; const API = 'http://localhost:3001/api'; const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOK }; const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join(''); const get = (id) => fetch(API + '/notes/' + id, { headers: H }).then((r) => r.json()); const put = (id, b) => fetch(API + '/notes/' + id, { method: 'PUT', headers: H, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, cc: r.headers.get('cache-control'), body: await r.json() }));
```

**Lock**:
- `await navigator.locks.query()` mostra `notiq-vault-note:<id>` (shared o exclusive) e `notiq-vault-reconcile`.
- Per tenere occupato il lock del giro da un'altra scheda: `navigator.locks.request('notiq-vault-reconcile',()=>new Promise(()=>{}))`. Lo rilasci chiudendo o ricaricando quella scheda.

**S-SEED-CODA**: item finto in coda (ricetta di `vault-conflict.spec.ts:198-205`). Il seed grezzo non sveglia le liveQuery di Dexie: dopo il seed usa "Controlla ora", oppure ricarica.
```js
(async function(id, err, withTitle){ var uid=JSON.parse(localStorage.getItem('auth-storage')).state.user.id; var db=await new Promise(function(ok){var o=indexedDB.open('NotiqDB');o.onsuccess=function(){ok(o.result)}}); var tx=db.transaction(['notes','syncQueue'],'readwrite'); var g=tx.objectStore('notes').get(id); g.onsuccess=function(){ var data={content:g.result.content}; if (withTitle) data.title='x'; tx.objectStore('syncQueue').add({type:'UPDATE',entity:'NOTE',entityId:id,userId:uid,data:data,createdAt:Date.now(),attempts:1,status:'failed',lastError:err}); }; tx.oncomplete=function(){db.close();console.log('seeded')}; })('ID','vault:stale',true)
```

**S-ROW**: modifica il content di una riga Dexie, per F.6 e F.7. Il secondo argomento è una funzione sul content.
```js
(async function(id, fn){ var db=await new Promise(function(ok){var o=indexedDB.open('NotiqDB');o.onsuccess=function(){ok(o.result)}}); var tx=db.transaction('notes','readwrite'); var st=tx.objectStore('notes'); var g=st.get(id); g.onsuccess=function(){ var n=g.result; n.content=fn(n.content); st.put(n); }; tx.oncomplete=function(){db.close();console.log('riga modificata')}; })('ID', function(c){ return c.replace(/^nv3\.0\./,'nv3.1.'); })
```

### P0.9 Dati legacy

**Ricetta A: via REST.** È veloce ed è uguale all'E2E.
- Il server accetta le scritture legacy finché non esiste un keyring.
- Eseguila da loggato con l'utente nuovo, **prima di aprire /vault**:
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
- La riga di CryptoJS prova prima `/@id/crypto-js` (risoluzione di Vite dev; `crypto-js` è una dipendenza diretta, `vite.config.ts:109`) e poi la risorsa già caricata. Se fallisce in entrambi i modi, salta `credPP`.
- Controllo finale: GET keyring risponde `status NONE` e `legacyCount 9`.

**Ricetta B: bundle `main` sulla stessa porta.**
- Un'altra porta non funziona, perché il CORS accetta solo :5173 (`app.ts:54`).
- Passi:
  1. `git worktree add D:\Develop\AI\Notiq-main main`
  2. `cd D:\Develop\AI\Notiq-main\frontend; npm ci`
  3. Ferma il Vite del branch e avvia `npx vite --port 5173 --strictPort` nel worktree. Il backend resta quello del branch.
  4. Su 2 profili persistenti (non incognito): imposta il vecchio PIN, crea credenziali e note sicure, e aprile tutte su B, così la copia locale si idrata.
  5. Torna al Vite del branch.

### P0.10 SQL sul DB dev

Usa pgAdmin, oppure `docker exec -it notiq-db psql -U <utente di DATABASE_URL> -d evernote_clone`. In psql imposta prima `\set u '<userId>'`.

```sql
-- keyring / lockout
SELECT "userId",status,epoch,rev,"migrationState","failedAttempts","lockedUntil",md5("escrowBlob") escrow,md5("pinSalt") salt FROM "VaultKeyring" WHERE "userId"=:'u';
UPDATE "VaultKeyring" SET "failedAttempts"=0,"lockedUntil"=NULL WHERE "userId"=:'u';          -- reset lockout
UPDATE "User" SET "tokenVersion"="tokenVersion"+1 WHERE email='<email>';                       -- forza un 401
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

### P0.11 Build di prod con il Service Worker (per la sezione K)

- In dev il SW non è attivo: `vite.config.ts` non ha `devOptions`.
- Da `D:\Develop\AI\Notiq\frontend`:
  ```powershell
  $env:VITE_WS_URL='ws://localhost:4173/ws'; npm run build
  npx vite preview --port 4173 --strictPort
  ```
- **L'override di `VITE_WS_URL` è obbligatorio.** `.env.production` punta a `wss://notiq.epartner.it/ws`. Senza override, la build locale aprirebbe la WS di collab e chat verso la **PROD**.
- `VITE_API_URL=/api` è relativo, e preview eredita `server.proxy`.
- Per andare offline sulla preview spunta anche Application, Service Workers, **Offline**.
- Dopo i test: Unregister del SW e Clear site data su :4173.

### P0.12 Copertura E2E di oggi (`frontend/e2e/vault-*.spec.ts`)

- **Coperti**:
  - Kit visibile solo dopo il 201;
  - multidevice;
  - sblocco offline e switch;
  - contesto nuovo offline in stato UNKNOWN;
  - conflitti A/B, editor aperto, 3 edit offline, bundle vecchio sintetico;
  - credenziale su un dispositivo pulito;
  - migrazione desktop da un solo dispositivo.
- **Non coperti**:
  - spostamenti dentro e fuori dal vault;
  - lockout, cambio PIN, rimozione dal dispositivo;
  - kill switch;
  - migrazione da 2 dispositivi e sua ripresa;
  - cache del SW con il SW attivo;
  - mobile, testi IT, dark mode;
  - trasformazioni Kanban e Task list;
  - pull completa con più di 50 note.

---

## A. Utente senza keyring, kill switch e stati del Gate

Ordine dei riavvii che riduce i cambi di stato:
1. `'*'`: A.1 a kill switch aperto, A.2, A.8, A.9;
2. chiuso: A.1 a kill switch chiuso, A.3, A.5;
3. canary: A.4;
4. pepper non valido: A.6;
5. pepper diverso ma valido: A.7;
6. di nuovo `'*'`, con il pepper originale.

Prima di partire, con `'*'`, crea R0 READY dalla UI: un setup rapido, una nota sicura e una credenziale.

- [ ] **A.1 (ex KS-01) — Utente senza keyring: note normali invariate, nessun traffico vault, "Aggiungi al Vault" porta al setup senza toccare la nota** (BLOCCANTE)
  - Prec.: U25 senza keyring, con 3-4 note normali (una con allegato, una condivisa). Ripeti tutto con il kill switch aperto e poi chiuso.
  - Passi:
    1. Usa /notes come al solito: crea, modifica, rinomina, cestina e ripristina. Poi, offline, modifica una nota, torna online e verifica il sync.
    2. Per tutto il passo 1 tieni Network con il filtro `vault`.
    3. Apri Impostazioni, sezione Vault, e controlla le voci presenti.
    4. Fai logout e login.
    5. Apri una nota normale, scrivi del testo e, prima che scada il debounce, scegli "Aggiungi al Vault" dal menu.
    6. Controlla `GET /api/notes/<id>`.
  - Atteso:
    - Nessuna chiamata `/api/vault/*` durante il passo 1. La GET del keyring parte solo da /vault, da "Aggiungi al Vault" o dalle sessioni vault.
    - In Impostazioni non c'è lo switch "Sblocco offline", perché manca la cache READY. Ci sono "Come funziona" e il link.
    - Kill switch aperto: si va a /vault, con il modulo di setup.
    - Kill switch chiuso: "Il vault non è ancora disponibile."
    - In entrambi i casi la nota resta NORMALE: `isVault:false`, titolo in chiaro, testo appena scritto salvato (flush prima della navigazione).
  - Non deve: chiamate vault periodiche; nota svuotata, cifrata o persa; testo perso nella navigazione; errori in Console.
  - Ispeziona: Network; Dexie `notes` (isVault false, contenuto in chiaro).
  - Base: `NoteEditor.tsx:445-448`; `vaultMove.ts:125-136`; `VaultSettingsSection.tsx:47,86`; `VaultPage.tsx:119-139`.
  - E2E: la suite non vault gira col bundle P2. "Aggiungi al Vault" senza keyring non è coperto.

- [ ] **A.2 (nuova, PULL-01) — Utente con più di 50 note: la pull completa non cancella righe (T0, TIER 1, vale per tutti gli utenti)** (BLOCCANTE)
  - Prec.: U60 senza keyring, con 60 o più note. Per il seed, da loggato con U60 (S-API caricato):
    ```js
    const nbs=await (await fetch(API+'/notebooks',{headers:H})).json(); const nb=(Array.isArray(nbs)?nbs:nbs.notebooks)[0].id; for (let i=0;i<62;i++){ const r=await fetch(API+'/notes',{method:'POST',headers:H,body:JSON.stringify({id:crypto.randomUUID(),notebookId:nb,title:'PULL-'+String(i).padStart(2,'0'),content:JSON.stringify({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'pull '+i}]}]})})}); if(!r.ok){console.log(i,r.status);break;} }
    ```
    Se compare un 429, attendi e riprendi dall'indice stampato.
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
  - Base: `syncService.ts:119`; piano §1 (`:95`), §12.22-23, passo 2 del runbook (`:682`).

- [ ] **A.3 (ex KS-02) — Kill switch chiuso: setupAllowed:false, schermata "non disponibile", 503 dal modulo già aperto, Riprova** (BLOCCANTE)
  - Prec.:
    - N1 (NONE).
    - N2 con il modulo di setup GIÀ aperto in un'altra finestra prima del riavvio.
    - F_ALTRO (legacy).
    - Backend riavviato "chiuso".
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
  - Base: `vault.service.ts:157-161,178,193,226-229`; `VaultPage.tsx:125-128,150-157,402`; `vaultSession.ts:69,238`; `it.json:1790`; piano `:292,668,684`.
  - Nota: il 503 setupDisabled non scrive un audit (residuo accettato).

- [ ] **A.4 (ex KS-03) — Canary: un userId, poi una lista con spazi, poi un id sbagliato** (BLOCCANTE)
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
  - Base: `vault.service.ts:158-161`; piano `:698-709`.

- [ ] **A.5 (ex KS-04) — Kill switch chiuso: chi è già READY continua a lavorare** (BLOCCANTE)
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
  - Base: `vault.service.ts:226-229`; `VaultPage.tsx:125-128`; CLAUDE.md (kill switch).

- [ ] **A.6 (ex KS-05) — Pepper non valido: Gate "unavailable" senza cache, ripiego offline con la cache** (MEDIA)
  - Prec.:
    - N4: non ha mai aperto il vault su questo browser.
    - R1: con cache READY e sblocco offline ON (share presente) su questo browser.
    - Backend riavviato con il pepper non valido.
  - Passi:
    1. N4 su /vault.
    2. R1 su /vault: inserisci il PIN.
    3. Ripristina il pepper e riavvia. Su N4 clicca "Riprova". R1 sblocca online.
    4. Confronta `vault-storage` e `notiq-vault-device` prima e dopo.
  - Atteso:
    - N4: GET 503 e "Il vault è temporaneamente non disponibile. Riprova più tardi.", con "Riprova". Non la schermata offline, non il setup.
    - R1: "Vault Bloccato", dalla cache READY. All'invio del PIN la GET `/keyring` risponde 503 (`preHandler`), `isUnreachable` accetta il 503 e parte lo sblocco offline. Compare il toast "Vault sbloccato", e nessuna POST `/unlock` va a buon fine.
    - Dopo il ripristino: N4 vede il setup e R1 sblocca online.
    - Durante il 503 gli storage non cambiano.
  - Non deve: setup durante il 503; cache o share cancellati.
  - Base: `routes/vault.ts:88-90`; `VaultPage.tsx:129-135,401`; `VaultUnlock.tsx:17-20,68-77`; `vault.service.ts:13-19,31-35`.

- [ ] **A.7 (nuova) — Pepper sostituito con uno valido: errors.vault.pepperMismatch** (MEDIA)
  - Prec.: R1 (offline ON su questo browser), R2 (offline OFF), N13 nuovo. Annota `failedAttempts` di R2. Riavvio con il pepper diverso ma valido (P0.2).
  - Passi:
    1. R2 su /vault: PIN corretto.
    2. R1 su /vault: PIN1.
    3. N13 su /vault: setup completo.
    4. SQL: `failedAttempts` di R2.
    5. Riavvia con il pepper originale. Sblocca R1 e R2 online.
  - Atteso:
    - GET `/keyring` 200. POST `/unlock` 503 `errors.vault.pepperMismatch`.
    - R2 vede "Il vault è temporaneamente non disponibile. Contatta l'assistenza."
    - R1 ripiega sullo sblocco offline (503 = irraggiungibile) e riceve il toast "Vault sbloccato".
    - N13 completa il setup, legato al nuovo `pepperKeyId`.
    - `failedAttempts` di R2 invariato: il pepper sostituito non conta come tentativo.
    - Dopo il ripristino R1 e R2 sbloccano. N13 resta inutilizzabile (pepperMismatch): buttalo.
  - Non deve: incremento del contatore; lockout; cache o share cancellati.
  - Base: `vault.service.ts:383-385`; `it.json:1786`; `VaultUnlock.tsx:17-20,75`.

- [ ] **A.8 (ex KS-06) — Gate "resetPending" forzato in SQL, e uscita dal vault con keyring non pronto** (MEDIA)
  - Prec.: R0 READY, con una nota sicura. Solo DB dev: ripristina subito dopo.
  - Passi:
    1. Sblocca R0 e apri la nota sicura. Poi esegui `UPDATE "VaultKeyring" SET status='RESET_PENDING' WHERE "userId"='<id>';`.
    2. Senza bloccare, clicca "Rimuovi dal Vault" (lucchetto aperto) e conferma.
    3. Blocca il vault, oppure ricarica /vault.
    4. Da una nota normale prova "Aggiungi al Vault" in due casi: (a) con la cache `byUser` READY presente, (b) dopo aver tolto `byUser[uid]` da `vault-storage` e ricaricato.
    5. Rimetti `status='READY'` e ricarica.
  - Atteso:
    - Passo 2: PUT 422 `errors.vault.notReady`, toast "Il vault non è pronto. Sbloccalo e riprova." (`vault.moveOut.notReady`). L'editor torna modificabile e `isVault` resta true.
    - Passo 3: solo "Il vault non è disponibile al momento." (`vault.resetPending`), senza moduli né pulsanti.
    - Passo 4a: con la cache READY, `vaultEntryState` restituisce `locked` e si apre il sheet del PIN. Lo sblocco vede `RESET_PENDING` e il sheet mostra "Il vault non è ancora pronto. Riprova tra poco." (`errors.vault.notReady`). La nota resta normale.
    - Passo 4b: senza cache, la GET dà uno status diverso da READY, quindi `setup`: si va a /vault, che mostra `vault.resetPending`.
    - Dopo il ripristino si torna allo sblocco.
  - Non deve: setup proposto; sblocco possibile; crash; nota spostata a metà.
  - Base: `VaultPage.tsx:126-128,403`; `vaultMove.ts:28,131-139`; `vaultSession.ts:116,183`; `VaultUnlockDialog.tsx:52-55`; `note.service.ts:290`; `VaultNoteEditor.tsx:222-232`; `it.json:594,1784`.

- [ ] **A.9 (ex KS-07) — Gate "loading" e "unknown": rete lenta e primo accesso offline** (ALTA)
  - Prec.:
    - R3 READY, creato su A.
    - Un contesto B mai usato per il vault.
    - Un utente NONE (N5).
    - Telefono Android.
  - Passi:
    1. B con Slow 3G: apri /vault e guarda i primi secondi. Una registrazione dello schermo aiuta.
    2. B: login online e resta su /notes. Poi Offline e clic su "Vault" nella sidebar. Clicca "Riprova" mentre sei ancora offline.
    3. Torna online senza cliccare nulla e attendi 2-3 s.
    4. Telefono: login online, modalità aereo, apri /vault, poi riattiva la rete.
    5. N5 offline su /vault, poi online.
  - Atteso:
    - Passo 1: solo "Caricamento...", poi "Vault Bloccato". Il modulo di setup non compare mai, nemmeno per un istante.
    - Passo 2: "Sei offline" con "Non riusciamo a contattare il server e su questo dispositivo non c'è ancora una copia del tuo vault..." e "Riprova" (`vault.offline.*`). "Riprova" da offline non cambia la schermata.
    - Passo 3: la pagina passa da sola a "Vault Bloccato" (evento online).
    - Passo 4: stesso comportamento sul telefono.
    - Passo 5: offline compare "Sei offline", mai "Configura il tuo Vault". Online compare il setup.
  - Non deve: setup con stato sconosciuto, anche per un istante; purge della cache; loop di richieste.
  - Base: `VaultPage.tsx:95,129-139,150-155,400,405`; `VaultOfflineNotice.tsx`; `it.json:527-529`; piano `:283`.
  - E2E: `vault-offline.spec.ts:139-178` copre il contesto nuovo offline. Il manuale aggiunge la comparsa del modulo con la rete lenta, la ripresa automatica e la modalità aereo vera.

---

## B. Migrazione dal vault legacy

Ogni giro usa un utente L* nuovo con la Ricetta A, salvo dove è indicata la Ricetta B. Esegui le voci prima di qualsiasi setup per quell'utente.

- [ ] **B.1 (ex MIG-01) — Wizard completo su un seed misto: esito, titoli, finalize e campi derivati NULL sul DB** (BLOCCANTE)
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
  - Non deve: NoteVersion in chiaro su id finalizzati; `searchText` o `searchVector` valorizzati; la credenziale bloccata modificata (nemmeno il title); il Kit prima del 201; titoli "Senza titolo" dopo il reconcile.
  - Ispeziona: in Network 1 POST `/keyring` 201, `/vault/items` paginato, `/vault/migrate`, `/vault/items {ids}`, `/vault/finalize`. Tutte con `no-store`.
  - Base: `vaultMigration.ts:57-62,120-131,262-285,288-314`; `vault.service.ts:496-544,546-578`; `VaultMigrate.tsx:336-353`; migration `20260218000000_add_fulltext_search`; `it.json:427`.
  - E2E: `vault-migration.spec.ts` copre il nucleo. Il manuale aggiunge i campi derivati NULL, la credenziale JSON, la nota con `isEncrypted`, il cestino, tooLarge, i testi, `migrationState` e l'audit.

- [ ] **B.2 (ex MIG-02) — Nessun plaintext residuo sul dispositivo dopo la migrazione** (BLOCCANTE)
  - Prec.: subito dopo B.1, sullo stesso profilo, senza reload.
  - Passi:
    1. Subito dopo "Fine", esegui S-DUMP con gli aghi MK-BODY-A, MK-BODY-C, MK-PW-CV2, MK-PW-CPP, MK-TITLE-A. Annota lo store e il campo di ogni ago trovato (per esempio `searchText`).
    2. Controlla `vault-storage`: niente `pinHash`, niente plaintext.
    3. Ricarica online, sblocca e attendi 10-20 s (pull). Ripeti S-DUMP.
    4. Controlla Dexie `notes` (righe isVault) e `syncQueue`.
  - Atteso:
    - Dopo il reload e la pull restano solo MK-TITLE-LOCK, MK-TITLE-BIG e MK-BODY-BIG, cioè gli item rimasti legacy per scelta.
    - Le righe migrate hanno `nv3.` e title `''`.
    - Niente `pinHash` (clearLegacy). Coda vuota.
  - Non deve: MK-BODY-* o MK-PW-* rimasti dopo la pull.
    - Da osservare: il reconcile non tocca `searchText`. Se MK-BODY compare solo nel primo dump, annotalo come residuo temporaneo.
    - Se resta anche dopo il reload online, è un difetto.
  - Base: `vaultMigration.ts:363-380`; `syncService.ts:176-220`; `vaultReconcile.ts:304-334`.
  - Limite: `api-cache` si verifica solo nella build di prod (K.1).

- [ ] **B.3 (ex MIG-03) — Credenziale bloccata: si sblocca dopo, aggiungendo il PIN mancante** (ALTA)
  - Prec.: il riepilogo di B.1 è ancora aperto. Per la variante serve un utente nuovo.
  - Passi:
    1. Nei "PIN precedenti" del riepilogo aggiungi `unknown77` e clicca "Riprova". Poi Q1 e Q2.
    2. Variante: chiudi il riepilogo senza `unknown77` e apri MK-TITLE-LOCK.
    3. Nella lista c'è il banner "1 elementi da aggiornare." con "Apri il vault per aggiornarli": cliccalo. Si apre il wizard in modalità resume, solo con i PIN precedenti.
    4. Inserisci `K7rQ2X`, poi `unknown77`.
  - Atteso:
    - Con `unknown77`: `credLock` diventa `nv3`, con title `''`, e Q2 = 1. Valori decifrati: user-lock, MK-PW-LOCK.
    - Con `K7rQ2X`: di nuovo lockedSummary con n=1, md5 invariato.
    - Aprirla prima di migrarla mostra "Decrittazione credenziale fallita", e non parte nessun salvataggio.
  - Non deve: `/migrate` con l'id di `credLock` quando il PIN è sbagliato; PUT da un form in decryptFailed; banner che sparisce mentre la bloccata esiste.
  - Base: `VaultMigrate.tsx:245,343-350`; `vaultMigration.ts:268-269`; `CredentialForm.tsx:112-116,124,426-429`; `VaultPage.tsx:421-425,632-651`.
  - UX da annotare: "Apri il vault per aggiornarli" compare anche quando sei già nel vault; la forma "1 elementi".

- [ ] **B.4 (ex MIG-04) — Migrazione da 2 dispositivi in parallelo: 201 + 409, un solo keyring, nessuna perdita (accettazione 14-15)** (BLOCCANTE)
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
    - Ogni lato conta nel proprio riepilogo gli item che ha inviato e verificato, compresi gli `already`. Quindi ogni lato ne conta al massimo 7, la somma A+B può superare 7, e insieme coprono tutti i 7 migrabili.
    - Ogni item migrabile è `nv3` una volta sola. Nessuna versione in chiaro. md5 di `credLock` invariato. Conteggio delle righe uguale a quello iniziale.
    - Il PIN di B non sblocca nulla.
    - Nessun riepilogo mostra errori "invalid".
    - `migrationState`: DONE se non resta nulla di legacy.
    - "Controlla ora": "Tutto aggiornato."
  - Non deve: un secondo keyring; "Il server ha rifiutato un elemento"; "(copia in conflitto)"; il Kit su B; item rimasti legacy oltre a lock e big.
  - Base: `VaultMigrate.tsx:197-206,227-242`; `vault.service.ts:496-578` (`already` `:514`, `conflict` `:517`, CAS `:520-525`); `vaultMigration.ts:310,332-335,349,361-374`.
  - Limite: la gara al millisecondo fra due POST è coperta solo dagli unit test del backend.

- [ ] **B.5 (ex MIG-05) — Sblocco col PIN dell'altro dispositivo nel wizard (409): PIN errato, lockout, Annulla** (ALTA)
  - Prec.: come B.4, fino alla fase di sblocco su B.
  - Passi:
    1. Inserisci 6 PIN errati diversi. Dopo ognuno, interroga il keyring.
    2. Al 7° tentativo usa PIN1.
    3. Clicca "Annulla", poi invia PIN1 nella schermata di sblocco.
    4. Fai scadere il lockout in SQL (`UPDATE "VaultKeyring" SET "lockedUntil"=now() ...`) e sblocca con PIN1.
    5. Usa il banner e poi il resume fino alla fine della migrazione.
  - Atteso:
    - Tentativi 1-6: "PIN errato" (il 6° è ancora un 403). `failedAttempts` va da 1 a 6. `lockedUntil` resta NULL fino al 5°.
    - Dopo il 6°: `lockedUntil` circa now + 15 min, audit, email (se c'è lo SMTP).
    - 7° tentativo con PIN1 durante il lockout: "Il vault è bloccato. Sbloccalo con il PIN; dopo troppi tentativi errati attendi prima di riprovare." (`errors.vault.locked`).
    - "Annulla" porta a un VaultUnlock pulito, senza conto alla rovescia. Al primo invio (anche col PIN giusto) compare "Troppi tentativi. Riprova tra …" e non parte nessuna POST.
    - Dopo lo sblocco `failedAttempts` = 0, e i campi del wizard sono vuoti.
  - Non deve: migrazione senza chiavi; un secondo POST `/keyring`.
  - Base: `VaultMigrate.tsx:227-242,311-319`; `VaultUnlock.tsx:40-46,83-87`; `vault.service.ts:374-445`; `vaultSession.ts:117-118`.
  - UX da annotare: il wizard non mostra il tempo residuo; nella fase di sblocco del wizard il PIN errato resta nel campo (`VaultMigrate.tsx:236-239`, nessun `setUnlockPin('')` nel catch).

- [ ] **B.6 (ex MIG-06) — Passo 0 (flush): modifiche legacy in coda prima del keyring, flushTimeout, Riprova** (ALTA)
  - Prec.: L3 con la Ricetta A, `/notes` aperto (riga noteA in Dexie).
  - Passi:
    1. Con S-SEED-CODA aggiungi per noteA un UPDATE con status `pending`, `attempts 0` e data `{title:'MK-TITLE-A2', content: doc('MK-BODY-A3')}`.
    2. Attiva il Request blocking su `api/notes*` (host secondo P0.1).
    3. Su /vault compila e clicca "Avvia l'aggiornamento".
    4. Attendi 30 s, leggi l'errore e clicca "Riprova".
    5. Togli il blocco, verifica che PIN e password siano conservati e clicca "Avvia".
    6. Completa e apri noteA.
    7. Variante: un item `failed` (`lastError 'validation'`) al posto di quello pending.
  - Atteso:
    - Dopo circa 30 s: "Alcune modifiche sono ancora in attesa di sincronizzazione. Controlla la connessione e riprova." (`vault.migrate.errors.flushTimeout`).
    - "Riprova" riporta al modulo con i campi intatti.
    - Al secondo avvio, la PUT in chiaro risponde 200 prima del POST `/keyring`. La nota migrata ha MK-TITLE-A2 e MK-BODY-A3.
    - Con l'item `failed`, il passo 0 passa subito.
  - Non deve: POST `/keyring` prima del flush; modifica persa; PUT in chiaro dopo il 201.
  - Base: `vaultMigration.ts:141-170`; `VaultMigrate.tsx:189-193,329`; piano §6, passo 0.

- [ ] **B.7 (ex MIG-07) — Validazione del modulo del wizard e doppio submit (Avvia, Fine del Kit, Riprova)** (ALTA)
  - Prec.: L4 sul wizard. Prova le regole prima del submit valido.
  - Passi:
    1. PIN1 con una conferma diversa (`x9Kp4N`).
    2. PIN `123456`, poi `abcdef`, `Marco1`, `qwer12`, `a1a1a1`.
    3. Casella non spuntata.
    4. Password `wrongpass`.
    5. Password giusta e doppio clic rapido su "Avvia". Su un altro utente: doppio Invio.
    6. Doppio clic su "Fine" del Kit.
    7. Doppio clic su "Riprova" nel riepilogo con la credenziale bloccata.
  - Atteso:
    - "I PIN non corrispondono". Testi `vault.pinPolicy.*`.
    - Senza la casella il pulsante è disabilitato.
    - "Password dell'account non corretta.", con i campi conservati.
    - Un solo POST `/keyring`.
    - Doppio "Fine": un solo `onKitConfirmed` e un solo giro, perché `finish` ha la guardia `busy` e il pulsante è in `isLoading`. Nessuna `/migrate` duplicata.
    - Doppio "Riprova": nessun errore. Annota se partono due giri.
  - Non deve: due POST `/keyring`; errori "invalid"; copie in conflitto; Kit mostrato due volte.
  - Base: `VaultMigrate.tsx:99,166-218,220-225,349-351`; `RecoveryKitSheet.tsx:90-104,172`.

- [ ] **B.8 (ex MIG-08) — Interruzione dopo /migrate e prima di /finalize: la ripresa allo sblocco cancella le versioni in chiaro** (BLOCCANTE)
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
  - Base: `vaultReconcile.ts:749-762,798-818`; `vault.service.ts:458,559-563`; design §6.2.8.
  - Limite: il reconcile non finalizza una NOTE il cui content non è un documento TipTap (`body.type` diverso da `'doc'`, `vaultReconcile.ts:805-806`). Lo scenario è B.16, variante F. In prod, prima: `SELECT count(*) FROM "Note" WHERE "isVault" AND "noteType"='NOTE' AND content NOT LIKE '{%';`.

- [ ] **B.9 (ex MIG-09) — Abbandono a metà: durante il Kit, durante la ricifratura, subito dopo "Avvia"** (ALTA)
  - Prec.: un utente L* nuovo per ogni variante.
  - Passi:
    1. **K**: con il Kit visibile, clic su "Note" nella sidebar. Torna e sblocca.
    2. **M**: F5 con la barra a metà. Torna e sblocca.
    3. **S**: chiudi la scheda durante "Creazione delle chiavi del vault…" e riaprila.
    4. Per ogni variante: Q1, Q2, Q3 e la query del keyring.
  - Atteso:
    - **K**: keyring READY, Q2 = 9. Dopo lo sblocco compaiono "Il Kit di recupero non è stato confermato: rigeneralo." (con "Rigenera") e "9 elementi da aggiornare.". Il resume migra tutto.
    - **M**: gli item inviati sono `nv3` (finalizzati subito o dalla ripresa di B.8). Il resto lo completa il resume.
    - **S**: se il 201 è arrivato, si vede lo sblocco con il banner del Kit; altrimenti il wizard.
    - Il Kit non si ri-mostra mai.
  - Non deve: un item a metà (per ogni id: o il legacy originale, o un `nv3` uguale all'originale); ritorno al setup con il keyring presente.
  - Base: `VaultPage.tsx:184-197,350-355`; `VaultMigrate.tsx:103-111,197-201`; piano §12.17.

- [ ] **B.10 (ex MIG-10) — Chiusura con il lock occupato da un'altra scheda: Annulla, timeout di 30 s, Riprova** (MEDIA)
  - Prec.: L6 (con la Ricetta B, se vuoi vedere `pinHash`). Una scheda 2 su /notes tiene il lock del giro.
  - Passi:
    1. Fai il wizard fino a "Chiusura…".
    2. Clicca "Annulla".
    3. Clicca "Riprova" e attendi più di 30 s.
    4. Chiudi la scheda 2 e clicca "Riprova".
  - Atteso:
    - Sia "Annulla" sia il timeout danno "Un'altra scheda sta ancora lavorando sul vault. Riprova." (`vault.migrate.errors.busy`).
    - Dopo il rilascio: "Chiusura…", poi il riepilogo.
    - `pinHash` sparisce solo quando la chiusura riesce.
  - Non deve: clearLegacy o purge prima del giro; "Chiusura…" infinita senza pulsante.
  - Base: `VaultMigrate.tsx:20,146-164,303-307`; `vaultMigration.ts:363-380`; `vaultNoteLock.ts:11`.

- [ ] **B.11 (ex MIG-11) — Vault bloccato durante la ricifratura (logout in un'altra scheda)** (MEDIA)
  - Prec.: L7. Una scheda 2 su /notes.
  - Passi:
    1. Avvia il wizard e completa il Kit.
    2. Mentre la barra avanza, fai logout nella scheda 2.
    3. Osserva la scheda 1.
    4. Login, sblocco, poi Q1-Q3.
  - Atteso:
    - "Il vault si è bloccato. Sbloccalo e riprova." (`vault.migrate.errors.locked`), oppure il redirect al login.
    - Dopo lo sblocco: i finalizzati sono a posto, i non finalizzati li riprende il reconcile, il resto è nel banner.
  - Non deve: `/vault/migrate` dopo l'errore; envelope non decifrabili.
  - Base: `vaultMigration.ts:257-260`; `VaultMigrate.tsx:115-120`.

- [ ] **B.12 (ex MIG-12) — Secondo dispositivo con righe legacy in Dexie: la pull azzera i titoli, poi il reconcile allo sblocco (Ricetta B)** (ALTA)
  - Prec.: LB.
    - A e B hanno creato e aperto tutto su `main`.
    - Con `main` ancora attivo, A modifica la nota sicura N1 e B non la riapre.
    - Poi passa al bundle del branch.
  - Passi:
    1. B su /notes, online, senza aprire /vault.
    2. A: wizard completo, con il vecchio PIN di `main` come PIN precedente.
    3. Dopo 30-60 s controlla Dexie su B: righe isVault con title `''` e content ancora in chiaro.
    4. B apre /vault: deve comparire lo sblocco. Inserisci il PIN nuovo.
    5. Attendi il reconcile. Conta le "(copia in conflitto)" e aprile. Esegui Q1 e il conteggio.
    6. Su B: Impostazioni vault, "Controlla ora".
  - Atteso:
    - Titoli originali decifrati, nessuna "Nota senza titolo". Righe `nv3` con title `''`.
    - Note aggiornate: nessuna copia.
    - N1: esattamente 1 "(copia in conflitto)" con il contenuto VECCHIO di B. L'originale ha il contenuto di A.
    - Righe sul server = item originali + 1.
    - Le credenziali v2 non decifrabili su B restano invariate (LEAVE legacyPin).
    - Passo 6: "N elementi lasciati invariati. Cause possibili:" (`vault.settings.unresolved`) con tutte e 4 le righe `vault.settings.reason.*` (legacyPin, epoch, tooLarge, unchanged). L'elenco è sempre completo, non indica la causa del singolo item.
  - Non deve: copie con titolo vuoto su note invariate; originale sovrascritto dal contenuto vecchio; plaintext rimasto in Dexie (tranne gli item lasciati legacy).
  - Base: `syncService.ts:176-220`; `vaultReconcile.ts:232-250,304-334,838-846`; `VaultSettingsSheet.tsx:153,267-278`; spec T15 T6/T7.

- [ ] **B.13 (ex MIG-13) — Bundle vecchio dopo il keyring: 422, poi copia in conflitto (accettazione 16, Ricetta B)** (ALTA)
  - Prec.: dopo B.12, profilo B.
  - Passi:
    1. Avvia `main` su :5173.
    2. Su B apri il vault (vecchio PIN) e cambia la password di CV in `MK-PW-OLDBUNDLE`.
    3. Osserva la PUT, il banner e `syncQueue`.
    4. Torna al branch. Ricarica, sblocca col PIN nuovo e apri l'originale e la copia. Esegui Q1.
  - Atteso:
    - Su `main`: PUT 422 `errors.vault.plaintextRejected`, item `failed`, md5 sul server invariato.
    - Sul branch: 1 "(copia in conflitto)" con `MK-PW-OLDBUNDLE`, l'originale con il valore del server, coda vuota.
  - Non deve: un 200 su quella PUT; modifica persa; più di una copia.
  - Base: design §6.3; spec T15 T6/T9/T15.
  - E2E: `vault-conflict.spec.ts` lo copre in forma sintetica (IndexedDB scritta a mano).

- [ ] **B.14 (ex MIG-14) — Item oltre 2 MiB: resta in chiaro, in sola lettura, e si toglie dal vault** (MEDIA)
  - Prec.: fine di B.1.
  - Passi:
    1. Apri MK-TITLE-BIG e leggi il banner. Prova a scrivere nel titolo e nel corpo.
    2. Clicca il lucchetto aperto ("Rimuovi dal Vault"), poi "Conferma".
    3. Apri la nota in /notes. Esegui Q6.
  - Atteso:
    - Banner "Questa nota non è ancora nel nuovo formato del vault ed è in sola lettura. Puoi solo toglierla dal vault." Titolo e corpo non sono modificabili.
    - Toast "Rimosso dal Vault". La nota è in /notes con il titolo.
    - Q6: `isVault false`, `isEncrypted false`, `searchText` ricalcolato. Q2 scende di 1.
  - Non deve: salvataggi dalla fase legacy; 413 o 422 silenziosi (un errore deve dare un toast `vault.moveOut.*`).
    - Da osservare: se la riga ha content `''`, la fase è "unavailable" e il pulsante non c'è. Annotalo.
  - Base: `vaultMigration.ts:276`; `VaultMigrate.tsx:339`; `VaultNoteEditor.tsx:128-131,212-216,244,340-344`; `vaultReconcile.ts:237`.

- [ ] **B.15 (ex MIG-15) — Nota legacy nel cestino, nota legacy con allegato, item cancellato durante la migrazione** (MEDIA)
  - Prec.: L8 con la Ricetta A. Per l'allegato: caricalo su noteA prima del wizard, via REST o con la Ricetta B.
  - Passi:
    1. Fai il wizard completo. Esegui Q1 e Q3 su `noteTrash`.
    2. Apri il cestino delle note.
    3. Controlla il riepilogo per la nota con allegato, ed esegui `SELECT count(*) FROM "Attachment" WHERE "noteId"='<noteA>';`.
    4. Variante notFound: breakpoint su `/vault/migrate`. Da un'altra scheda cancella via REST (DELETE) un item non ancora inviato, poi riprendi.
  - Atteso:
    - `noteTrash`: `nv3`, title `''`, `isTrashed`, nessuna versione in chiaro.
    - Nel cestino nessun titolo in chiaro.
    - L'allegato resta collegato. Se il riepilogo non lo segnala, annota lo scostamento dal piano §6 (D3, "si segnala").
    - notFound: l'item esce dal conteggio senza errore.
  - Non deve: errori bloccanti.
  - Base: `vault.service.ts:148-153,449-490`; `vaultMigration.ts:334`; piano §6 e §12.7.

- [ ] **B.16 (nuova) — NOTE legacy con content non JSON: migrata byte per byte, oppure illeggibile e bloccata se troppo grande** (MEDIA)
  - Prec.: L9 nuovo, prima di aprire /vault. Della Ricetta A esegui solo le righe di setup (fino a `post`), poi:
    ```js
    ids.raw=await post({noteType:'NOTE',title:'MK-TITLE-RAW',content:'testo non JSON MK-RAW '+'w'.repeat(200),isEncrypted:false});
    await j(await fetch(API+'/notes/'+ids.raw,{method:'PUT',headers:H,body:JSON.stringify({content:'testo non JSON MK-RAW v2 '+'w'.repeat(200)})})); // versione in chiaro
    ids.rawBig=await post({noteType:'NOTE',title:'MK-TITLE-RAWBIG',content:'MK-RAWBIG '+'z'.repeat(1700000),isEncrypted:false});
    console.table(ids);
    ```
  - Passi:
    1. Wizard completo con PIN1. Leggi il riepilogo. Esegui Q1, Q3 e Q2.
    2. Apri MK-TITLE-RAW. Non scrivere nulla e osserva per 10 s Network e l'editor.
    3. Apri MK-TITLE-RAWBIG.
    4. Variante F (con un utente nuovo e la stessa ricetta): breakpoint su `/vault/finalize`, chiudi la scheda in pausa, riapri, sblocca, attendi 15 s, poi Q3.
  - Atteso:
    - RAW: classificata `ready` (content byte per byte), quindi `nv3`, verificata e finalizzata dal wizard. Q3 `plain_v` = 0, title `''`.
    - Apertura di RAW: da osservare come l'editor mostra un body non JSON. Requisito: nessuna PUT automatica e nessun testo perso se non scrivi nulla.
    - RAWBIG: compare nel riepilogo come troppo grande e resta in chiaro. All'apertura c'è il banner "Questo elemento è salvato in un vecchio formato e non si può mostrare qui. Aggiorna gli elementi del vault per aprirlo." (`vault.legacyUnreadable`), senza editor e senza "Rimuovi dal Vault" (serve `docOk`). L'item resta bloccato nel vault: annotalo come limite.
    - Variante F: il reconcile NON finalizza RAW (`body.type !== 'doc'`), quindi `plain_v` resta maggiore di 0, e Q2 non la conta (è `nv3`). Annotalo come limite noto.
  - Non deve: PUT di un documento vuoto su RAW; crash dell'editor; RAWBIG modificabile.
  - Base: `vaultMigration.ts:57-58,276,288-314`; `VaultNoteEditor.tsx:130-131,214,244,340-347`; `vaultReconcile.ts:805-806`; `it.json:516`.

---

## C. Setup nuovo

Usa gli utenti N* (Mario Rossi), con il backend su `'*'`.

- [ ] **C.1 (ex SK-01) — Setup completo su PC con ispezione di rete, storage e DB** (ALTA)
  - Prec.: N6, nessun keyring.
  - Passi:
    1. Apri /vault. GET `/keyring`: `NONE`, `legacyCount 0`, `setupAllowed true`, `no-store`.
    2. Controlla la schermata:
       - "Configura il tuo Vault" e "Crea un PIN per proteggere le tue note più private. Questo PIN sarà richiesto per accedere al Vault." (`vault.setupDescription`);
       - il riquadro ambra (`vault.setup.riskBody`);
       - le regole del PIN (`vault.setup.pinRules`);
       - i campi PIN, Conferma e Password;
       - le caselle "Consenti lo sblocco offline su questo dispositivo" e "Ho capito che senza PIN e Kit il mio vault non è recuperabile.".
    3. Con un campo vuoto, o senza "Ho capito", "Crea Vault" deve essere disabilitato.
    4. PIN `k7Rq2x`, conferma uguale, password `password123`. Casella offline vuota, "Ho capito" spuntata. Clicca "Crea Vault".
    5. Durante lo spinner aggiorna `pending`: deve esserci `<userId>:kit {kind:'kit', escrowHash, confirmed:false}`.
    6. Al 201 controlla il payload della POST e i campi presenti.
    7. Riscrivi i 2 gruppi e clicca "Fine".
    8. Controlla `pending`, `vault-storage` e l'SQL.
    9. Esegui S-DUMP con il primo gruppo del Kit.
    10. Ricarica.
  - Atteso:
    - Il payload contiene password, authKey, wrappedVkPin ed escrowBlob. Non contiene il PIN né un campo pin. Nessuna POST `/unlock`.
    - Dopo "Fine": toast "Vault configurato con successo", vault sbloccato e vuoto ("Nessuna nota sicura trovata."), nessun banner ambra kitUnconfirmed.
    - Il marker `<userId>:kit` è sparito.
    - `byUser[userId]` = `{status:'READY', epoch:0, rev, kdf:'argon2id', kdfParams:{m:65536,t:3,p:1}, pinSalt, rootKeyId:'rk_68a265761e7e37c7', offlineUnlock:false}`, senza `wrappedVkPin`.
    - SQL: `READY`, `migrationState NONE`, `failedAttempts 0`, escrow non nullo.
    - S-DUMP: `trovato=false` ovunque.
    - Dopo il reload: "Vault Bloccato" con "Inserisci il tuo PIN per accedere alle note sicure." (`vault.lockedDescription`). Il Kit non si trova da nessuna parte.
  - Non deve: Kit prima del 201; PIN in un payload o in Console; Kit in uno storage; banner dopo una cerimonia confermata.
  - Base: `VaultSetup.tsx:61-96,107,197-211`; `vaultSession.ts:175-267,270`; `VaultPage.tsx:114,158,185-197`; `VaultUnlock.tsx:103`; `vault.service.ts:174-195,221-292`; `it.json:427-436`.
  - E2E: `vault-kit.spec.ts:7-85` copre il Kit dopo il 201, lo stato READY e il Kit assente dopo il reload. Non copre testi, marker, byUser, banner e storage.

- [ ] **C.2 (ex SK-02) — Policy del PIN (accettazione 4): tabella dei PIN rifiutati e accettati** (BLOCCANTE)
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
  - Base: `PinPolicy.ts:20,31-100`; `VaultSetup.tsx:69-72,83-87`; `it.json:431,531-538`; design `:528`.
  - E2E: no, solo unit. La parte maiuscole e minuscole è coperta da `vault-multidevice`.

- [ ] **C.3 (ex SK-03) — maxLength 6 al setup, nessun maxLength allo sblocco: incolla di 7 caratteri** (MEDIA)
  - Passi:
    1. Incolla `k7Rq2xZ` in PIN e in Conferma. In Console, `input.value` deve valere `k7Rq2x`.
    2. Completa il setup e blocca.
    3. Incolla `k7Rq2xZ` nel campo di sblocco.
  - Atteso:
    - Al setup il valore viene troncato in silenzio.
    - Allo sblocco: "PIN errato" e `failedAttempts` +1. È un rischio di UX da giudicare.
  - Non deve: sblocco riuscito con 7 caratteri; lockout dopo un solo tentativo.
  - Base: `VaultSetup.tsx:147,160`; `VaultUnlock.tsx:113-125`; `vault.service.ts:393-403`.

- [ ] **C.4 (ex SK-04) — Gestore password del browser e tastiere sui campi PIN** (ALTA)
  - Prec.: Chrome con la password di login salvata per localhost:5173. Un utente nuovo. Poi il telefono.
  - Passi:
    1. Nel campo PIN Chrome propone "Usa password suggerita"? Se sì, accettala in un giro di prova: la policy deve rifiutarla con `format`. Una password forte più lunga di 6 caratteri viene troncata da maxLength.
    2. Il campo "Password dell'account" (autocomplete off) viene riempito?
    3. Completa il setup. Compare "Salvare la password?" o "Aggiornare la password?", e con quale valore? Non accettare. In un secondo giro, con un altro utente, accetta.
    4. Logout: quale password propone l'autofill nel login?
    5. Allo sblocco (`current-password`) il campo PIN viene riempito con la password dell'account?
    6. Telefono: la prima lettera non deve diventare maiuscola (`autoCapitalize` off). Ripeti per "PIN attuale", "Nuovo PIN" e "PIN per confermare".
  - Atteso:
    - Nessuna credenziale di login sostituita dal PIN. Se succede, annotalo come difetto UX (proposta: un `autocomplete` diverso).
    - Autofill nel campo di sblocco: annotalo, perché un clic diventa un tentativo errato.
  - Non deve: password di login sovrascritta dal PIN senza che l'utente se ne accorga; tentativi errati causati dall'autofill.
  - Ispeziona: icona della chiave nella barra; `chrome://password-manager/passwords`; SQL `failedAttempts`.
  - Base: `VaultSetup.tsx:138-171`; `VaultUnlock.tsx:112-125`; `VaultSettingsSheet.tsx:155-170`.
  - Limite: il comportamento cambia con browser e versione. Ripeti in prod col portachiavi iCloud.

- [ ] **C.5 (ex SK-05) — Password dell'account errata e rate limit di POST /keyring** (ALTA)
  - Prec.: N8. Backend appena riavviato (contatori a zero).
  - Passi:
    1. PIN valido, password `sbagliata1`, "Crea Vault".
    2. Ripeti fino alla sesta POST nell'ora.
    3. Esegui Q5.
    4. Riavvia con `'*'` e usa la password giusta.
  - Atteso:
    - Passo 1, dopo 1-2 s: "Password dell'account non corretta." (403). La password viene svuotata, il PIN no. Nessun Kit, nessun marker, nessuna riga in SQL.
    - Sesta POST: 429 e "Troppe richieste. Riprova tra poco." (`errors.vault.rateLimited`).
    - Q5: un `vault.keyring.passwordRejected` per ogni 403.
    - Dopo il riavvio compare il Kit.
  - Non deve: Kit dopo un 403; marker rimasto dopo un 403 o un 429; logout causato dal 403.
  - Base: `vault.service.ts:231-236`; `routes/vault.ts:96`; `vaultApi.ts:31-35,50-58`; `vaultSession.ts:69,238`; `VaultSetup.tsx:81-87`.

- [ ] **C.6 (ex SK-06) — Setup e rete: offline prima del clic, caduta durante il calcolo, riprova** (ALTA)
  - Prec.: N9.
  - Passi:
    1. Offline: compare "Sei offline. Per creare il vault serve la connessione." (`vault.setup.offline`) e il pulsante è disabilitato.
    2. Online, senza ricaricare: il messaggio sparisce e il pulsante si abilita.
    3. Slow 3G, compila e clicca. Appena la GET `/keyring` si completa, passa a Offline.
    4. In SQL controlla se la POST è arrivata.
    5. Online: reinserisci la password e clicca "Crea Vault".
  - Atteso:
    - Passo 3: "Errore di rete. Controlla la connessione e riprova.". Nessun Kit, password svuotata. Il marker può restare.
    - Passo 5: se il keyring non c'era, compare il Kit. Se c'era: "Vault Bloccato" con il riquadro verde "Il vault è già stato creato su un altro dispositivo: inserisci il PIN scelto lì.". Dopo lo sblocco compare il banner "Il Kit di recupero non è stato confermato: rigeneralo.".
  - Non deve: due keyring; Kit senza 201; setup riproposto quando il server è READY.
  - Base: `VaultSetup.tsx:27-40,63,129-134,202`; `vaultSession.ts:178-182,209-240,483-502`; `VaultPage.tsx:159,404`.
  - E2E: `vault-kit.spec.ts:15-21` copre la POST abortita.
  - Limite: con DevTools non si sceglie se la POST arriva. Lo stato finale equivalente si verifica con D.4.
  - UX da annotare: dopo un 201 perso sullo stesso dispositivo il testo dice "altro dispositivo", che in quel caso è fuorviante.

- [ ] **C.7 (ex SK-07) — Doppio clic e doppio invio su "Crea Vault", "Fine" e "Genera nuovo Kit"** (ALTA)
  - Passi:
    1. Doppio clic rapido su "Crea Vault". In un altro giro: doppio Invio nel campo password; doppio tap su Android.
    2. Doppio clic su "Fine" nel foglio del Kit.
    3. Con il vault sbloccato apri Impostazioni vault, scrivi il PIN in "PIN per confermare", poi doppio clic e doppio Invio su "Genera nuovo Kit". Conta le PUT e controlla `pending`.
  - Atteso:
    - Passo 1: una sola POST, Kit mostrato, nessun riquadro "già creato".
    - Passo 2: un solo toast "Vault configurato con successo".
    - Passo 3, da osservare: `submitKit` ha solo `kitBusy` (stato React), quindi due submit nello stesso tick possono produrre 2 PUT. Se partono 2 PUT, la seconda prende 409, il suo `escrowHash` è diverso e `clearPending('kit')` cancella il marker mentre il foglio della prima rigenerazione è aperto. Se poi abbandoni la cerimonia, il banner non comparirebbe. Annota il numero di PUT e la presenza di `<userId>:kit` con il foglio aperto.
  - Non deve: 2 POST; Kit perso; due fogli del Kit.
  - Base: `VaultSetup.tsx:58-64`; `vaultSession.ts:231-237,444-461`; `RecoveryKitSheet.tsx:90-104`; `VaultSettingsSheet.tsx:127-143`.

- [ ] **C.8 (ex SK-08) — Due dispositivi sullo stesso utente: setup già fatto altrove, in sequenza e in parallelo** (ALTA)
  - Prec.: N10 su A e B, entrambi con il modulo visibile. Per il parallelo serve un altro N, con un breakpoint XHR su A.
  - Passi:
    1. **Sequenza**: A completa setup e Kit. B, senza ricaricare, compila con un PIN diverso (`m4Xt9q`) e clicca "Crea Vault".
    2. **Parallelo**: A va in pausa sulla POST (F8 sulla GET). B completa setup e Kit. A riprende. In alternativa, clic quasi simultanei.
    3. Su A prova il PIN di A, poi quello di B. Controlla `pending`.
  - Atteso:
    - Sequenza: B non fa nessuna POST (vede READY) e mostra "Vault Bloccato" con il riquadro verde. Il PIN di B fallisce, quello di A sblocca e il riquadro sparisce.
    - Parallelo: 201 sul vincitore e 409 `errors.vault.alreadySetup` sul perdente. Il perdente non vede mai un Kit: vede lo sblocco con il riquadro verde, e il suo PIN dà "PIN errato". Sul perdente niente `<userId>:kit` e niente banner. SQL: una sola riga, con l'escrow del vincitore.
  - Non deve: due Kit; Kit sul 409; keyring sovrascritto.
  - Base: `vaultSession.ts:175-267` (409 `:231-237`); `vault.service.ts:264-289`; `VaultPage.tsx:97,159,404`; `VaultUnlock.tsx:105-109`.

- [ ] **C.9 (ex SK-27) — Opzione di sblocco offline al setup e default OFF rispetto al design** (MEDIA)
  - Passi:
    1. Setup con la casella spuntata. Controlla `byUser` (`offlineUnlock:true`, `wrappedVkPin`), `deviceKeys` e `shares` (`{epoch, shareEnc, wrappedVkSigKey}`).
    2. Blocca, vai Offline senza reload e sblocca.
    3. Setup senza la casella: niente share.
    4. Osserva il default della casella (non spuntata).
    5. R3 in incognito, prima dello sblocco: Impostazioni, Vault. Poi ripeti dopo lo sblocco online.
  - Atteso:
    - Con la casella spuntata lo sblocco offline funziona. Nessun toast "Non è stato possibile attivare lo sblocco offline su questo dispositivo.".
    - Su B prima del primo sblocco: solo "Come funziona" e il link. Dopo lo sblocco: switch OFF e `shares` vuoto.
    - Da decidere: il design dice "attivo di default" (`design:19,243`), il codice parte da OFF.
  - Non deve: uno share salvato senza consenso.
  - Base: `VaultSetup.tsx:50,78,173-181`; `vaultSession.ts:94-104,243-254,276`; `vaultStore.ts:119-133`; `VaultSettingsSection.tsx:84`.
  - E2E: `vault-offline` copre il setup con offline ON.

- [ ] **C.10 (ex SK-23) — Argon2id nel Worker: tempi e UI durante il calcolo (PC e Android)** (MEDIA)
  - Passi:
    1. Cronometra il setup dal clic al Kit (atteso circa 0,5-2 s su PC).
    2. Durante il calcolo lo spinner deve restare fluido. Annota se i campi restano modificabili: vale il PIN del momento del clic.
    3. Opzionale: profilo Performance. Il lavoro deve stare sul thread `argon2.worker`.
    4. Cronometra lo sblocco.
    5. Ripeti su Android, anche con molte app aperte.
  - Atteso:
    - Pochi secondi, UI reattiva.
    - Se il Worker fallisce compare "Qualcosa è andato storto. Riprova." e si può riprovare. Manca una chiave `kdfFailed` dedicata: valuta se basta.
    - Oltre 30 s il Worker viene terminato.
  - Non deve: UI congelata; doppio calcolo.
  - Base: `argon2.ts:4,6,22-48,66-78,82-89`; `VaultSetup.tsx:22-25,65,201`.
  - Limite: i tempi validi per D4 si misurano solo in prod (N.5).

- [ ] **C.11 (ex SK-24) — /admin/vault-bench: solo SUPERADMIN, fuori da AppLayout, nessuna rete, Stop e Copia** (ALTA)
  - Passi:
    1. Da sloggato apri la rotta: redirect a /login.
    2. Come utente normale: redirect a /notes.
    3. SUPERADMIN: Admin, "Benchmark vault". La pagina "Benchmark Argon2id" è a tutto schermo, senza sidebar, con `vaultBench.intro` e lo stato "Pronto".
    4. Hard reload con Network vuoto: nessuna `/api/sync`, `/api/notes`, `/api/vault`, nessuna WS `/ws` o `/chat-ws`.
    5. "Avvia": stato "In corso...", righe da t=3, JSON incrementale, "Avvia" disabilitato.
    6. "Stop": stato "Fermato", la CPU torna a riposo.
    7. "Copia": `app` = versione di package.json, `DEFAULT_KDF {m:65536,t:3,p:1}`, `standalone false`, `entry ""` (in dev), results con median, p95 e cold.
    8. Lascialo arrivare in fondo: "Completato" oppure "Fermato: limite superato".
    9. "Torna all'admin" durante la corsa: la CPU smette di lavorare.
    10. Ricarica: negli storage non è stato salvato nulla.
    11. Android (via `adb reverse`): pagina usabile, bottoni da 44 px. Il caso http://IP-LAN è in M.1.
    12. Tema scuro.
  - Non deve: pagina visibile a un non admin; sync o WS avviati dalla pagina; calcolo che continua dopo Stop o dopo l'uscita.
  - Base: `App.tsx:59-76,89-91`; `VaultBenchPage.tsx:51-54,72,93-165,183-186,213,246-251`; `AdminPage.tsx:95-99`; `it.json:1577-1598`.
  - Limite: in dev i numeri non contano.

---

## D. Kit di recupero

- [ ] **D.1 (ex SK-09) — Cerimonia del Kit: gruppi, normalizzazione, modale non chiudibile, focus, dark mode** (ALTA)
  - Passi:
    1. Formato: 8 gruppi di 4 separati da `-`, poi 2 spazi e 2 caratteri di controllo. Alfabeto Crockford: nessuna I, L, O o U.
    2. Le etichette "Gruppo N" sono diverse, in ordine crescente e casuali.
    3. Un gruppo sbagliato e uno giusto: "Fine" resta disabilitato, la spunta verde compare solo sul giusto.
    4. Normalizzazione: minuscole, trattini o spazi interni, O al posto di 0, l o I al posto di 1. Tutti accettati.
    5. Prova 13 caratteri: il campo ne accetta al massimo 12.
    6. Esc, clic sullo sfondo, Tab e Shift+Tab: il foglio resta aperto e il focus resta dentro.
    7. Sidebar, header, menu, notifiche e scorciatoie da tastiera non devono essere raggiungibili sotto l'overlay.
    8. Ripeti in tema scuro.
    9. Opzionale: screen reader. Deve leggere "Kit di recupero" e "Codice del Kit di recupero".
  - Non deve: chiusura con Esc o con lo sfondo; gruppo giusto respinto; "Fine" abilitato con un solo gruppo.
  - Base: `RecoveryKitSheet.tsx:21-30,44-48,106-175`; `vaultKit.ts:2,33-43`.
  - E2E: `vault-kit.spec.ts:48-77` copre Esc, clic, gruppo sbagliato e minuscole.
  - Nota: in P2 la cerimonia non usa i caratteri di controllo. Servono al recupero (P4) e sono coperti dagli unit test.

- [ ] **D.2 (ex SK-10) — Copia del Kit negli appunti** (MEDIA)
  - Passi:
    1. "Copia": toast "Kit copiato".
    2. Incolla in Blocco note: identico allo schermo, con i 2 spazi.
    3. Incolla un gruppo nei campi.
    4. Ripeti su Android.
    5. Blocca il permesso degli appunti dal lucchetto e riprova.
  - Atteso: con il permesso bloccato compare il toast "Impossibile copiare" e il foglio resta aperto.
  - Non deve: copia parziale; errore silenzioso.
  - Base: `RecoveryKitSheet.tsx:40,81-88`; `vaultKit.ts:33-38`.
  - Limite: su http://IP-LAN la clipboard non c'è.

- [ ] **D.3 (ex SK-11) — PDF del Kit: contenuto, lingua, visualizzatori, mobile** (ALTA)
  - Passi:
    1. "Scarica PDF": si scarica `notiq-vault-recovery-kit.pdf`.
    2. Aprilo con Chrome, Edge e Acrobat. Deve essere 1 pagina A4 con:
       - il titolo "Notiq Vault - Kit di recupero" e le righe `pdfLine1-3`;
       - il Kit in Courier grassetto;
       - a piè di pagina "Generato da Notiq";
       - nessun `?` e a capo a 85 caratteri.
    3. Confronta il Kit carattere per carattere, controlli compresi. Fallo anche col testo copiato dal PDF.
    4. Stampa in A4.
    5. Secondo download: file identico e foglio ancora aperto.
    6. Interfaccia in inglese (utente nuovo): "Notiq Vault - Recovery Kit".
    7. Android: il file finisce in Download e si apre. Tornando a Chrome, foglio e Kit sono ancora lì.
  - Non deve: PDF vuoto o corrotto; Kit diverso; `vault.kit.errors.pdfOverflow`; foglio chiuso.
  - Base: `kitPdf.ts:12-86`; `RecoveryKitSheet.tsx:62-79`; `it.json:567-571`.
  - E2E: controlla solo nome, header e dimensione.
  - Limite: i caratteri fuori Latin-1 non sono osservabili con le lingue attuali. iOS solo in prod.

- [ ] **D.4 (ex SK-12) — Cerimonia abbandonata (reload, chiusura, Indietro, logout, rigenerazione): banner kitUnconfirmed** (BLOCCANTE)
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
  - Base: `RecoveryKitSheet.tsx:55,90-104`; `vaultSession.ts:210,270,444,483-502`; `VaultPage.tsx:185-197,350-355,427-432`; `deviceKeyStore.ts:19-21,76`.
  - Nota: non c'è `beforeunload` né una guardia sulla history: valuta se servono. iOS solo in prod.

- [ ] **D.5 (ex SK-13) — Marker con escrowHash diverso dal server: si cancella in silenzio** (ALTA)
  - Prec.: A con il marker abbandonato (come in D.4), non ancora sbloccato.
  - Passi:
    1. B: sblocca, rigenera e conferma.
    2. A: sblocca.
    3. Variante: A sblocca offline. La GET fallisce: nessun banner e marker conservato. Poi online: blocca e risblocca.
  - Atteso: banner solo se l'hash è uguale. Con un hash diverso il marker viene cancellato senza messaggi. Se la GET fallisce, il marker resta.
  - Base: `vaultSession.ts:483-502`.

- [ ] **D.6 (ex SK-14) — Keep-alive dell'auto-lock durante la cerimonia (oltre 10 minuti)** (ALTA)
  - Passi:
    1. Rigenerazione: foglio aperto, 11-12 minuti senza toccare nulla. Il foglio resta aperto con lo stesso Kit. Dopo "Fine" lo sheet è sbloccato.
    2. Setup: foglio aperto 11-12 minuti, poi "Fine". Si vede la lista sbloccata.
    3. Scheda in background per 12 minuti: il foglio resta aperto e il vault non si blocca.
    4. Android: foglio aperto e schermo spento per 12 minuti. Se il vault si è bloccato e il Kit è perso, al prossimo sblocco deve comparire il banner (D.4).
    5. Controllo inverso: dopo "Fine", 11 minuti fermi. Il vault si blocca.
  - Non deve: foglio smontato su PC; auto-lock disattivato per sempre.
  - Base: `RecoveryKitSheet.tsx:56-60`; `vaultStore.ts:4,8-11,113-117,134-139`; `VaultPage.tsx:114,199-209,398-404`; `VaultSettingsSheet.tsx:91-104,132-135`.

- [ ] **D.7 (ex SK-15) — Rigenerazione del Kit dallo sheet: PIN errato, lockout, offline, vecchio Kit invalidato** (ALTA)
  - Prec.: utente sbloccato. Annota l'md5 dell'escrow e `rev`.
  - Passi:
    1. Ingranaggio: sezione "Kit di recupero" (`vault.settings.kitBody`), campo "PIN per confermare", "Genera nuovo Kit" disabilitato col campo vuoto.
    2. PIN errato: "PIN errato" nello sheet, campo svuotato, nessun Kit. `failedAttempts` +1, escrow invariato.
    3. Offline: "Sei offline: cambio PIN e Kit richiedono la connessione." e pulsante disabilitato.
    4. PIN giusto: PUT 200, poi un Kit DIVERSO. "Fine": toast "Kit di recupero confermato", e lo sheet resta aperto. Escrow cambiato, `rev` +1.
    5. Con un utente dedicato, 6 PIN errati qui, poi un 7° tentativo.
    6. Con il vault bloccato, l'ingranaggio e "Genera nuovo Kit" non esistono.
  - Atteso al passo 5:
    - I tentativi 1-6 danno sempre "PIN errato". Dopo il 6° l'SQL mostra `lockedUntil` valorizzato.
    - Il 7° dà subito "Il vault è bloccato. Sbloccalo con il PIN; dopo troppi tentativi errati attendi prima di riprovare." (`errors.vault.locked`), senza calcolo Argon2 e senza POST.
    - Lo sblocco successivo mostra il conto alla rovescia dopo il primo invio.
  - Non deve: Kit prima del 200; rigenerazione da bloccato o offline.
  - Base: `VaultSettingsSheet.tsx:93-104,127-143,224-235`; `vaultSession.ts:115-160,421-472`; `vault.service.ts:393-424`; `it.json:639-652,1783`.
  - E2E: `vault-kit.spec.ts:87-123` copre il PIN errato, il Kit nuovo e l'azione assente da bloccato.

- [ ] **D.8 (ex SK-16) — Rigenerazione e cambio PIN concorrenti da due dispositivi** (MEDIA)
  - Prec.: utente sbloccato su A e su B, Impostazioni aperte, breakpoint XHR `vault/keyring` su A.
  - Passi:
    1. **Kit contro Kit**: "Genera nuovo Kit" su A e B a meno di mezzo secondo, oppure A in pausa sulla PUT mentre B completa.
    2. **Kit contro PIN**: A in pausa sulla PUT del Kit, B cambia il PIN, A riprende.
    3. **PIN contro PIN**: A cambia il PIN verso PIN_X (F8 sulla GET, pausa sulla PUT). B cambia verso PIN_Y fino al toast. A riprende. In Network: PUT 409, poi GET, poi PUT 200. Blocca entrambi e prova PIN_Y e PIN_X.
  - Atteso:
    - 409 sul Kit: il perdente mostra "Il Kit di recupero non è stato aggiornato. Riprova." (`errors.vault.kitNotUpdated`), nessun Kit, marker cancellato. In sequenza vince l'ultimo.
    - PIN contro PIN: vale PIN_X, l'ultimo. PIN_Y dà "PIN errato" anche su B, che però aveva ricevuto "PIN cambiato": annotalo come UX. `rev` +2.
  - Non deve: un keyring che non si sblocca con nessuno dei due PIN; Kit senza PUT riuscita.
  - Base: `vaultSession.ts:389-411,446-465`; `vault.service.ts:362-366`; `it.json:1782`.
  - Limite: dipende dai tempi. Se non ottieni il 409, annota "non verificato".

- [ ] **D.9 (ex SET-05) — Kit non confermato e poi cambio PIN: il promemoria del Kit sopravvive** (ALTA)
  - Passi:
    1. Setup con PIN1. Chiudi la scheda durante la cerimonia.
    2. Sblocca: banner e `<userId>:kit` presenti. Annota l'md5 dell'escrow.
    3. Cambia il PIN da PIN1 a PIN2 senza usare il banner.
    4. Reload e sblocco con PIN2.
    5. Dal banner: "Rigenera", PIN2, cerimonia. Poi reload.
  - Atteso:
    - Dopo il cambio PIN: escrow invariato, marker presente, banner al reload. Con entrambi i marker vince kitUnconfirmed (`vaultSession.ts:497-498`).
    - Dopo la rigenerazione: toast, escrow cambiato, marker sparito, niente banner.
  - Non deve: vecchio Kit ri-mostrato; rigenerazione con PIN1.
  - Base: `deviceKeyStore.ts:75-76`; `vaultSession.ts:359-415,421-472,483-502`; `VaultPage.tsx:185-197,427-431`.

---

## E. Sblocco, lockout, blocco e auto-lock

Si usano R1 (offline ON) e R2 (lockout). Ogni PIN errato online conta: azzera il contatore fra una voce e l'altra.

- [ ] **E.1 (ex SU-01) — Sblocco online con PIN corretto: cosa resta sul dispositivo** (ALTA)
  - Passi: apri /vault con R1 bloccato, campo a fuoco, scrivi PIN1 e premi Invio. Cronometra.
  - Atteso:
    - Testo sotto il titolo: "Inserisci il tuo PIN per accedere alle note sicure." (`vault.lockedDescription`).
    - Spinner, poi toast "Vault sbloccato" (`vault.unlocked`) e titoli decifrati.
    - 1 GET e 1 POST `/unlock` 200, entrambe `no-store`.
    - `byUser`: `READY`, `epoch`, `rev`, `kdfParams`, `pinSalt`, `rootKeyId`, `offlineUnlock:true`, `wrappedVkPin`. Niente keys, `isUnlocked` o PIN. `pinHash` null.
    - `shares[R1]` = `{epoch, shareEnc, wrappedVkSigKey}`. `deviceKeys` è un CryptoKey con `extractable:false`.
    - Meno di 1-2 s su PC.
  - Non deve: PIN, authKey o serverShare in chiaro; una seconda POST; il setup.
  - Base: `vaultSession.ts:275-292`; `vaultStore.ts:119-133,174-176`; `VaultUnlock.tsx:61-81,103`; `routes/vault.ts:83-86`.
  - E2E: lo sblocco sì, lo storage e il conteggio delle POST no.

- [ ] **E.2 (nuova) — "PIN dimenticato?" (D5): solo informazione, nessun reset** (ALTA)
  - Passi:
    1. Sulla schermata di sblocco clicca "PIN dimenticato?" (`vault.forgotPin`) sotto il form.
    2. Leggi il riquadro, poi clicca di nuovo il link.
    3. In Network, durante i passi 1-2, non deve partire nessuna chiamata.
    4. Apri il sheet di sblocco da "Aggiungi al Vault" (VaultUnlockDialog) e cerca lo stesso link.
  - Atteso:
    - Compare il riquadro "Per ora il PIN non è recuperabile" (`vault.unlock.forgotTitle`) con il testo `vault.unlock.forgotBody` ("In questa versione, se dimentichi il PIN il vault non può essere reimpostato né recuperato…").
    - Il secondo clic lo chiude, e `aria-expanded` passa da true a false.
    - Nessun campo e nessun pulsante di reset. Nessuna chiamata di rete.
    - Nel VaultUnlockDialog il link non c'è: annota se serve.
    - Il link è un'area di tocco da 44 px ed è leggibile in tema scuro.
  - Non deve: un pulsante di reset; una chiamata a `/api/vault/*`.
  - Base: `VaultUnlock.tsx:142-159`; `it.json:447,552-553`.

- [ ] **E.3 (ex SU-02) — PIN sbagliato, PIN con maiuscole invertite e doppio invio** (ALTA)
  - Passi:
    1. `123abc` e Invio.
    2. `X9kP4m` e clic.
    3. `x9x9x9` con Invio e subito dopo un clic.
    4. SELECT dopo ognuno.
    5. PIN1.
  - Atteso:
    - "PIN errato" in rosso (`errors.vault.invalidPin`, `role=alert`), campo svuotato.
    - Il doppio invio produce una sola POST 403 e un solo +1 al contatore.
    - Dopo i 3 errori `failedAttempts=3`, `lockedUntil` NULL.
    - PIN1 sblocca e azzera il contatore.
  - Base: `VaultUnlock.tsx:43,63-66,82-89`; `vaultSession.ts:148`; `vault.service.ts:391-435`.
  - E2E: `vault-multidevice.spec.ts:29-38` copre il PIN sbagliato e quello con le maiuscole.

- [ ] **E.4 (ex SU-03) — Lockout al 6° errore: testo, conto alla rovescia, PIN corretto rifiutato, scadenza** (BLOCCANTE)
  - Prec.: R2 con `failedAttempts=0`. Lo SMTP dev, se vuoi vedere l'email.
  - Passi:
    1. 6 PIN sbagliati diversi (`a1b2c9` … `f6a7b9`).
    2. SELECT.
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
  - Base: `vault.service.ts:393-436`; `vaultSession.ts:117-119,149-153`; `VaultUnlock.tsx:48-59,83-87,122,127-134`; `email.service.ts:482-494`; `it.json:551`.
  - Limite: senza SMTP c'è solo il warn `vault lockout email failed`.

- [ ] **E.5 (ex SU-04) — Backoff di 1 h e 24 h, contatore che non si azzera, formato del tempo** (MEDIA)
  - Passi:
    1. In SQL imposta `failedAttempts=11` e `lockedUntil` NULL. Fai 1 errore, poi 1 tentativo.
    2. Ripeti con 17 e con 23.
    3. Azzera.
  - Atteso:
    - Al 12°: +1 h, "Riprova tra 59:5x".
    - Al 18°: +24 h, "Riprova tra 1439:5x". Da segnalare come UX: `fmt()` mostra solo minuti e secondi.
    - Al 24°: resta +24 h (tetto `LEAST(...,3)`).
    - Un'email a ogni soglia.
  - Base: `vault.service.ts:396-399`; `VaultUnlock.tsx:28-31`.

- [ ] **E.6 (ex SU-05) — Lockout visto da un altro dispositivo, e sblocco offline durante il lockout** (ALTA)
  - Prec.: R1 con offline ON sul telefono, oppure su B già sbloccato una volta.
  - Passi:
    1. PC: 6 errori.
    2. Telefono online: PIN1.
    3. Telefono offline, senza reload: PIN1, poi 3 PIN sbagliati.
    4. SQL, poi azzera.
  - Atteso:
    - Online: "Troppi tentativi…" senza POST.
    - Offline: sblocco riuscito, anche col server in lockout (rischio dichiarato, `design:243`).
    - Gli errori offline non hanno limite e il contatore del DB non cambia.
  - Base: `vaultSession.ts:117-119,295-335`; `VaultUnlock.tsx:69`.

- [ ] **E.7 (ex SU-06) — VaultUnlockDialog da "Aggiungi al vault" nell'editor normale** (ALTA)
  - Prec.: R1 READY e bloccato. Una nota normale non condivisa, non pubblica e senza allegati.
  - Passi:
    1. Menu della nota, "Aggiungi al vault". Per una nota non condivisa e non pubblica il dialog "Avviso Importante" non compare: si apre subito il sheet del PIN.
    2. Nel sheet "Sblocca il vault" ("Inserisci il PIN per spostare questa nota nel vault.") inserisci `X9kP4m`.
    3. PIN1 con doppio Invio.
    4. Apri /vault entro 10 minuti.
    5. Fai un altro "Aggiungi al vault".
    6. Variante con R2 in lockout.
    7. Variante offline.
    8. Telefono: la tastiera non deve coprire il campo.
  - Atteso:
    - PIN errato: "PIN errato" nel sheet, che resta aperto.
    - PIN giusto: una sola POST, il sheet si chiude, la nota va nel vault (`notes.addedToVault`) e l'editor si chiude.
    - /vault è già sbloccato. Il secondo spostamento non chiede il PIN.
    - Lockout: "Troppi tentativi. Riprova tra mm:ss" fisso, campo abilitato.
    - Offline: comando disabilitato (`vault.moveIn.offline`).
    - 10 minuti dopo lo sblocco il vault si blocca, anche se lavori su /notes.
  - Non deve: spostamento col PIN errato; sheet in caricamento infinito.
  - Base: `NoteEditor.tsx:439-453,787,845,994`; `VaultUnlockDialog.tsx:28,30,36-61,80-85`; `vaultStore.ts:134-139`; `VaultPage.tsx:199-209`.

- [ ] **E.8 (ex SU-20) — Dispositivo B (incognito e telefono vero): chiede il PIN e decifra** (ALTA)
  - Passi:
    1. Su B: login con R3, poi /vault.
    2. `X9kP4m`, poi PIN1 dalla tastiera del telefono.
    3. Apri la nota e la credenziale.
    4. Impostazioni, Vault: controlla lo switch.
  - Atteso:
    - "Vault Bloccato", mai "Configura il tuo Vault". Il PIN errato dà "PIN errato".
    - Nessuna maiuscola automatica. Annota il tempo sul telefono.
    - Dati identici al PC. Switch OFF.
  - Base: `VaultPage.tsx:126-127,404`; `VaultUnlock.tsx:112-125`.
  - E2E: la finestra B è coperta da `vault-multidevice.spec.ts:21-51`.

- [ ] **E.9 (ex SU-12) — Backend fermo su un dispositivo con offline ON (l'atteso dipende da P0.1)** (MEDIA)
  - Passi:
    1. Ferma il backend.
    2. Ricarica /vault e inserisci PIN1 con R1. Ripeti con R2.
    3. Riavvia con `'*'` e ripeti.
  - Atteso:
    - In entrambi i casi la pagina mostra "Vault Bloccato" dalla cache. Da osservare se, con un 500 dal proxy, il Gate resta sulla cache.
    - **Chiamate dirette (:3001)**: connessione rifiutata, status `(failed)` in Network, `VaultApiError(0,'network')`. R1 sblocca offline con il toast. R2 vede "Errore di rete. Controlla la connessione e riprova.".
    - **Chiamate dal proxy (:5173)**: Vite risponde 500. Un 5xx diverso da 503 non attiva il ripiego: R1 e R2 vedono "Qualcosa è andato storto. Riprova.".
    - Col backend riavviato lo sblocco online riesce.
  - Non deve: setup o purge.
  - Base: `api.ts:5`; `vaultApi.ts:50-57`; `VaultUnlock.tsx:17-20,74-77`.
  - Limite: il 502 di IIS si vede solo in prod.

- [ ] **E.10 (ex SU-13) — Rete che cade a metà sblocco, fra GET e POST** (MEDIA)
  - Passi:
    1. R1 con Slow 3G: PIN1 e Invio. Appena la GET è completata, vai Offline.
    2. SELECT.
    3. R2: stessa sequenza.
    4. Online e sblocco normale.
  - Atteso:
    - R1: POST con status 0, ripiego offline riuscito.
    - R2: "Errore di rete. Controlla la connessione e riprova.", vault bloccato, campo svuotato.
    - Contatore invariato in entrambi i casi.
  - Non deve: spinner infinito; stato sbloccato con la lista vuota.
  - Base: `VaultUnlock.tsx:68-78,88-92`; `vaultSession.ts:130-160`.

- [ ] **E.11 (ex SU-24) — Reload o chiusura della scheda durante lo sblocco** (MEDIA)
  - Passi:
    1. Slow 3G, PIN1, poi F5 con la POST pendente.
    2. Ripeti chiudendo la scheda.
    3. Sblocca online, poi offline.
  - Atteso:
    - "Vault Bloccato".
    - In `shares` c'è lo share vecchio o quello nuovo, mai uno corrotto (stessa epoch).
    - Gli sblocchi successivi funzionano.
    - `failedAttempts=0` se la POST era arrivata col PIN giusto.
  - Non deve: `offlineUnavailable` permanente.
  - Base: `vaultSession.ts:94-104,280-291`; `deviceKeyStore.ts:59-73`.

- [ ] **E.12 (ex SU-14, include VQ-24) — Auto-lock dopo 10 minuti di inattività, con e senza editor aperto** (ALTA)
  - Passi:
    1. Sblocca e non toccare nulla per 10:15.
    2. Clic nella lista ogni 4 minuti, per 12 minuti.
    3. Apri una nota lunga e scorri solo con la rotellina per 11 minuti.
    4. Apri "Segreto A", scrivi `ultimo` e fermati. Attendi il blocco. Controlla `navigator.locks.query()`, `syncQueue` e Network. Sblocca.
  - Atteso:
    - Passo 1: a circa 10:00 si vede "Vault Bloccato" (`vault.lockedTitle`) e l'editor si chiude.
    - Passo 2: il vault resta sbloccato.
    - Passo 3: il vault si blocca. È l'atteso dal codice: valuta l'UX di chi legge senza cliccare.
    - Passo 4: `ultimo` presente, solo envelope, nessun lock orfano.
  - Non deve: testo in chiaro a schermo dopo il blocco; `[vault] pre-lock flush failed`.
  - Base: `vaultStore.ts:4,8-18,100-117,134-139`; `VaultPage.tsx:144-148,199-209`; `VaultNoteEditor.tsx:110-115,159-165`.

- [ ] **E.13 (ex SU-15) — Auto-lock con la scheda in background o l'app sospesa (PC e Android; iOS in N.8)** (ALTA)
  - Passi:
    1. PC: sblocca e passa a un'altra scheda per 15 minuti.
    2. Android: schermo spento o un'altra app per 15 minuti.
    3. Al ritorno guarda subito se titoli e credenziali sono visibili.
  - Atteso:
    - Requisito: al ritorno il vault deve essere già bloccato, oppure bloccarsi prima che si possa leggere qualcosa.
    - Se resta leggibile anche per pochi secondi è un difetto: manca un controllo su `visibilitychange` o sul tempo assoluto.
  - Base: `vaultStore.ts:6-18`.

- [ ] **E.14 (ex SU-16, include VQ-03) — Uscita dal vault con una modifica non ancora salvata (meno di 1 s): Indietro, Blocca, sidebar, telefono, offline** (BLOCCANTE)
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
  - Base: `VaultPage.tsx:350-355`; `vaultStore.ts:97-112`; `VaultNoteEditor.tsx:26,84-108,152-165`; `CredentialForm.tsx:169-182,398`.

- [ ] **E.15 (ex SU-17) — "Blocca Vault" con una modifica pendente e doppio clic** (ALTA)
  - Passi:
    1. Scrivi ` LK1` e clicca subito 2 volte "Blocca Vault".
    2. Sblocca e riapri.
  - Atteso: blocco immediato, ` LK1` presente, solo envelope, nessun errore in Console.
  - Base: `VaultPage.tsx:489`; `vaultStore.ts:97-112`.

- [ ] **E.16 (ex SU-18) — Logout con il vault sbloccato e una modifica pendente** (BLOCCANTE)
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
  - Base: `authStore.ts:75-83`; `vaultStore.ts:97-112`; `VaultNoteEditor.tsx:88-100`.
  - E2E: `vault-multidevice.spec.ts:54-62` copre il logout senza modifica pendente.

- [ ] **E.17 (ex SU-19) — Logout da 401 (token revocato) a vault sbloccato** (ALTA)
  - Passi:
    1. Scrivi ` T401` e attendi 2 s.
    2. In SQL esegui `tokenVersion+1`.
    3. Scrivi ` T402` e attendi il 401 (dalla push o da un clic), poi il refresh 401 e il logout.
    4. Controlla lo storage. Login e sblocco.
    5. Variante: offline, blocca e risblocca offline.
  - Atteso:
    - Redirect a /login, vault bloccato, cache intatta.
    - ` T402` è in coda come envelope con userId R1.
    - Entrambi i testi sono presenti. Lo sblocco offline funziona.
  - Non deve: perdite; loop di refresh.
  - Base: `api.ts:33-37,59-62`; `app.ts:180-186`; `authStore.ts:75-83`; HANDOFF §5.

- [ ] **E.18 (ex VQ-04, include S14) — Reload o chiusura entro 1 s dall'ultimo tasto** (MEDIA)
  - Passi:
    1. In una nota sicura scrivi ` R1` e premi subito F5.
    2. Scrivi ` R2`, attendi 2 s, F5.
    3. Scrivi ` R3` e premi subito Ctrl+W.
    4. Stessa prova nel campo password di una credenziale.
    5. Telefono: scrivi ` R4` e chiudi l'app dallo switcher.
    6. Scheda in background: scrivi `bg1` e passa subito a un'altra scheda con Ctrl+Tab per 15 s. Da B verifica `bg1`. Poi lascia la scheda nascosta più di 6 minuti mentre B scrive `B14`: torna e apri.
    7. Confronto: la stessa prova su una nota NORMALE.
  - Atteso:
    - R2 c'è sempre. R1, R3 e R4 possono mancare: è la finestra del debounce di 1 s, perché non c'è un flush su `pagehide` o `beforeunload`. Annota il risultato.
    - **Decisione utente (23/10): perdita della finestra di 1 s ACCETTATA.** Non è un difetto bloccante; resta da verificare solo che non si perda testo scritto più di 1 s prima.
    - `bg1` arriva entro pochi secondi.
    - La nota mostra `B14` senza copia.
  - Non deve: riga corrotta (`vault.notLoaded` o decifratura fallita); copia dopo il reload; perdita di testo scritto più di 1 s prima.
  - Base: `VaultNoteEditor.tsx:26,110-115,152-156`; `CredentialForm.tsx:157-167,366-377`; `useSync.ts:46-60`; `main.tsx:54`.

---

## F. Uso quotidiano e invarianti del plaintext

Usa aghi univoci: TITOLO-SEGRETO-0n, CORPO-SEGRETO-0n, PW-SEGRETA-0n.

- [ ] **F.1 (ex VQ-01) — Nota sicura nuova: titolo e corpo mai in chiaro (UI, Dexie, coda, rete, DB)** (BLOCCANTE)
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
  - Base: `VaultPage.tsx:61-80,239-250`; `VaultNoteEditor.tsx:84-108`; `syncService.ts:608-622`; `note.service.ts:60-68,298-306`.
  - E2E: `createSecureNoteUi` controlla l'envelope. Il dump c'è solo per le credenziali.

- [ ] **F.2 (ex VQ-02) — Rinomina e propagazione al dispositivo B** (ALTA)
  - Passi:
    1. Su A cambia solo il titolo in TITOLO-SEGRETO-02. Controlla la PUT.
    2. Su B torna alla lista. Se non si aggiorna, blocca e risblocca.
    3. Apri la nota su B e ordina per titolo.
  - Atteso:
    - PUT con solo content e baseHash.
    - B mostra il titolo nuovo, ordinato sul testo decifrato, con title `''` in Dexie.
  - Non deve: chiave title nella PUT; titolo vecchio fisso; "Senza titolo" su B.
  - Base: `VaultNoteEditor.tsx:254-262`; `syncService.ts:618-621`; `VaultPage.tsx:270-320`; `vaultReconcile.ts:624-642`.

- [ ] **F.3 (ex VQ-05) — Lock shared per tutto il mount e decifratura solo dopo il grant** (ALTA)
  - Passi:
    1. Apri N e lancia `navigator.locks.query()`: c'è `{name:'notiq-vault-note:<id>', mode:'shared'}`.
    2. Indietro: dopo 1-2 s il lock non c'è più.
    3. Con N chiusa: `navigator.locks.request('notiq-vault-note:<id N>', {mode:'exclusive'}, () => new Promise((r) => { window._rel = r; }))`. Poi apri N.
    4. Osserva per 10 s, poi `window._rel()`.
    5. Ripeti i passi 3-4 con una credenziale.
    6. Con N aperta: Offline per 3 s e poi Online (parte il reconcile) mentre scrivi.
  - Atteso:
    - Con l'exclusive tenuto: schermata di caricamento (VaultNotLoaded loading), nessun campo, nessuna scrittura.
    - Dopo il rilascio il contenuto si decifra.
    - Il testo aperto non viene sostituito.
  - Non deve: testo decifrato prima del rilascio; caricamento infinito; lock orfano.
  - Base: `VaultNoteEditor.tsx:117-157`; `CredentialForm.tsx:83-86,379-401`; `vaultNoteLock.ts:10`.
  - Limite: senza `navigator.locks` (http://IP) lo stato è `nolocks` (`VaultNoteEditor.tsx:150`). Non è un bug.

- [ ] **F.4 (ex VQ-07) — Nota non ancora caricata sul dispositivo B (idratazione, offline)** (ALTA)
  - Passi:
    1. Su B, con una nota mai aperta (content `''` in Dexie): Offline e apri N.
    2. "Riprova" (`vault.notLoadedRetry`).
    3. Online, poi "Riprova".
    4. Ripeti con una credenziale.
  - Atteso:
    - "Questo elemento non è ancora stato caricato su questo dispositivo. Connettiti a internet e riprova." (`vault.notLoaded`).
    - Online: POST `/api/vault/items {ids:[id]}` (`no-store`), poi il contenuto decifrato.
    - La credenziale non mostra il form finché il contenuto non arriva.
  - Non deve: editor vuoto modificabile; PUT di un documento vuoto o di `EMPTY_CREDENTIAL`; `length(content)` cambiato sul server.
  - Base: `VaultNoteEditor.tsx:122-129,236-240`; `vaultReconcile.ts:624-642`; `VaultPage.tsx:340-348`; `CredentialForm.tsx:122-124,422-424`.
  - E2E: `vault-overwrite` copre la credenziale su un dispositivo pulito.

- [ ] **F.5 (nuova) — Elemento eliminato sul server mentre B non l'ha mai caricato: "non esiste più"** (ALTA)
  - Prec.: B con la riga N mai idratata (content `''`) e la credenziale C mai aperta. Online.
  - Passi:
    1. A elimina definitivamente N e C.
    2. B, prima che la pull lo rimuova, apre N.
    3. B apre C.
  - Atteso:
    - N: `hydrateVaultNote` vede `absent` e rimuove la riga. Compare "Questo elemento non esiste più sul server." (`vault.itemNotFound`) con solo "Indietro", senza "Riprova". In alternativa l'editor si chiude da solo.
    - C: il percorso passa da `VaultPage.hydrateId` e `CredentialForm` mostra `vault.notLoaded`. Annota l'incoerenza con N.
  - Non deve: PUT o CREATE che ricreano l'item; caricamento infinito.
  - Base: `VaultNoteEditor.tsx:125-128,237`; `VaultNotLoaded.tsx:18,26`; `CredentialForm.tsx:422-424`; `VaultPage.tsx:329-348`; `it.json:457`.

- [ ] **F.6 (ex VQ-08) — Envelope locale manomesso: errore gestito e auto-riparazione online** (MEDIA)
  - Passi:
    1. Offline. Con S-ROW cambia un carattere della parte `<ct>` di N (per esempio `c => c.slice(0,-2)+(c.slice(-2,-1)==='A'?'B':'A')+c.slice(-1)`).
    2. Apri N, poi "Riprova".
    3. Online, chiudi e riapri.
    4. Ripeti con una credenziale.
  - Atteso:
    - Offline: stato "unavailable" e `[vault] load failed` in Console. Per la credenziale: "Decrittazione credenziale fallita" (`vault.credential.decryptFailed`).
    - Online: `hydrateVaultNote` sostituisce la riga (synced, hash diverso) e la nota si apre.
  - Non deve: PUT dell'envelope manomesso; editor modificabile; crash.
  - Base: `VaultNoteEditor.tsx:141-145`; `CredentialForm.tsx:112-116,426-436`; `vaultReconcile.ts:637-639`.

- [ ] **F.7 (nuova) — Riga locale con epoch diversa (T8, reason.epoch)** (MEDIA)
  - Prec.: N synced. Offline.
  - Passi:
    1. Con S-ROW sostituisci `nv3.0.` con `nv3.1.` nella riga di N.
    2. Apri N, poi "Riprova".
    3. Torna online senza aprire N, poi Impostazioni vault, "Controlla ora".
    4. Apri N. Esegui `nq('N')` e `sq(['N'])`.
  - Atteso:
    - Offline: stato "unavailable" con "Riprova".
    - "Controlla ora": LEAVE(epoch), quindi `vault.settings.unresolved` con le 4 righe `reason.*`.
    - Riapertura online: da osservare se `hydrateVaultNote` ripara la riga, dato che l'hash è diverso da quello del server.
  - Non deve: PUT dell'envelope `nv3.1.` (il server lo rifiuterebbe come `stale`); DROP della riga; copia in conflitto.
  - Base: spec T15 T8; `vaultReconcile.ts:838-840`; `VaultNoteEditor.tsx:125,141-145`; `VaultSettingsSheet.tsx:267-278`.

- [ ] **F.8 (ex VQ-09) — Eliminazione definitiva di note e credenziali (online, offline, subito dopo una modifica)** (ALTA)
  - Passi:
    1. N1 nel cestino. Prima "Annulla", poi "Elimina per sempre" (`common.deleteForever`).
    2. N2: scrivi ` Z` ed entro mezzo secondo elimina.
    3. Offline: C1, cestino in alto a destra, conferma. Torna online.
    4. SQL: righe e conteggio delle NoteVersion.
    5. B ha N1 aperta.
  - Atteso:
    - Dialog "Elimina Definitivamente" con "Sei sicuro di voler eliminare definitivamente questo elemento? L'azione non può essere annullata.". Toast "Eliminato definitivamente".
    - Credenziale: "Sei sicuro di voler eliminare definitivamente questa credenziale?..." e toast "Credenziale eliminata".
    - La riga sparisce, il DELETE entra in coda e poi la coda si svuota. 0 righe in Note e in NoteVersion (cascade).
    - N2 non riappare. Su B l'editor si chiude da solo.
  - Non deve: PUT o CREATE dopo il DELETE; versioni orfane; nota finita nel Cestino normale.
  - Base: `VaultNoteEditor.tsx:189-204`; `CredentialForm.tsx:347-363`; `noteService.ts:262-278`; `schema.prisma:167-170`; `VaultPage.tsx:328-338`.

- [ ] **F.9 (ex VQ-10) — Pin, unpin e scorciatoia nella sidebar** (MEDIA)
  - Passi:
    1. Stella (`notes.pin`).
    2. Nella sidebar, "Scorciatoie": clic sulla voce.
    3. Lista del vault: le note fissate stanno in alto?
    4. Unpin.
  - Atteso:
    - PUT `{isPinned:true}` 200. Toast `notes.pinned`, poi `notes.unpinned`.
    - Da decidere: la nota vault compare in sidebar come "Senza titolo" (`usePinnedNotes` non filtra `isVault`). Il clic porta a `/notes?noteId=`, e NotesPage la chiude subito. La lista del vault non ordina per pin.
  - Non deve: envelope mostrato come testo; scritture; `[noteService] scrittura vault rifiutata`; WS `/ws` aperta.
  - Base: `VaultNoteEditor.tsx:172-187`; `usePinnedNotes.ts:5-9`; `Sidebar.tsx:519-532`; `NotesPage.tsx:82-87`; `VaultPage.tsx:311-319`.

- [ ] **F.10 (ex VQ-11) — Promemoria su nota vault ed etichetta generica** (MEDIA)
  - Passi:
    1. Campanella, data e ora fra 2 ore.
    2. Riapri il selettore e controlla l'ora.
    3. Vai su Promemoria: spunta, poi clic sulla voce, poi sblocca.
    4. X rossa.
    5. Ripeti sul telefono (`showPicker`).
  - Atteso:
    - PUT `{reminderDate, isReminderDone:false}`, poi `{isReminderDone:true}`.
    - Etichetta "Promemoria del vault" (`vault.reminderGeneric`).
    - Il clic apre `/vault?noteId=` e, dopo lo sblocco, la nota.
    - Da annotare: l'ora mostrata è UTC (`toISOString().slice(0,16)`). Il difetto c'è già in `NoteEditor.tsx:772`, non è una regressione.
  - Non deve: titolo in chiaro in RemindersPage, in rete o in una notifica; selettore che non si apre sul telefono.
  - Base: `VaultNoteEditor.tsx:273-305`; `RemindersPage.tsx:60-75,130-133`.

- [ ] **F.11 (ex VQ-12) — Tag vault** (MEDIA)
  - Passi:
    1. Su N1 crea il tag `tagvault1`.
    2. Filtra nel vault.
    3. Controlla la lista dei tag normali e i payload.
  - Atteso:
    - Il filtro mostra solo N1. Il tag non compare fra quelli normali.
    - POST `/api/tags` con `isVault:true`. PUT della nota con tags, senza content.
  - Base: `VaultNoteEditor.tsx:270-272`; `VaultPage.tsx:264-267,549-557`; `useTags.ts:15`.

- [ ] **F.12 (ex VQ-13) — Elemento troppo grande: vault.tooLarge senza scrittura** (ALTA)
  - Passi:
    1. `copy('A'.repeat(1700000))` e incolla nel corpo di N. Attendi 3 s.
    2. Annulla l'incolla, scrivi ` OK` e attendi.
    3. Ripeti con "Note aggiuntive" di una credenziale.
  - Atteso:
    - Toast "Elemento troppo grande per essere salvato (max 2 MiB)" (`vault.tooLarge`). Nessuna PUT, coda invariata, envelope precedente in Dexie.
    - Dopo la riduzione la PUT riparte.
  - Non deve: 400 o 413; item `failed`; `length` cambiato nel DB.
  - Base: `VaultNoteEditor.tsx:27,95-98`; `CredentialForm.tsx:24,130-134`.
  - Limite: solo desktop.

- [ ] **F.13 (ex VQ-14) — Niente allegati, AI, condivisione e cronologia; paste e drop di immagini** (ALTA)
  - Passi:
    1. Header: solo Indietro, titolo, tag, campanella, stella, "Togli dal vault" e cestino.
    2. Incolla uno screenshot.
    3. Trascina un PNG dal disco.
    4. Incolla testo con un'immagine copiato da un sito.
    5. Network: filtri `attachments`, `ai`, `uploads`, domini esterni.
  - Atteso:
    - Screenshot e PNG non vengono inseriti.
    - La scheda NON naviga verso il file. Se apre il PNG a tutta pagina è un bug: perdi lo sblocco e l'ultimo secondo di modifiche.
    - Da decidere: se l'immagine remota viene inserita (nodo img con src http), il browser la scarica a ogni apertura e rivela l'IP e l'apertura.
    - Mai POST `/api/attachments` né `/api/ai`.
  - Base: `Editor.tsx:241-250`; `ImageDrop.ts:47-48,77-78`; `VaultNoteEditor.tsx:22-24,347-358`; `routes/attachments.ts:41`.

- [ ] **F.14 (ex VQ-15) — "Trasforma in Kanban o Task list" da una nota vault: plaintext al server** (BLOCCANTE)
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
  - Base: `Editor.tsx:615-639`; `EditorContextMenu.tsx:180-211`; `EditorToolbarSecondary.tsx:351-355`; `TransformToKanbanModal.tsx:111-120,152-162`.

- [ ] **F.15 (ex VQ-16) — Dettatura vocale e blocco cifrato legacy nella toolbar del vault** (MEDIA)
  - Passi: cerca "Avvia dettatura" (`editor.startDictation`) e "Inserisci blocco cifrato" (`editor.insertEncryptedBlock`). Opzionale: detta del testo.
  - Atteso:
    - Annota la presenza dei due comandi. La Web Speech API di Chrome invia l'audio a Google.
    - **Decisione utente (23/10): la dettatura vocale resta ABILITATA nel vault.**
    - Il testo viaggia solo nell'envelope.
  - Base: `EditorToolbar.tsx:36-58`; `EditorToolbarSecondary.tsx:230-231,265-269`.

- [ ] **F.16 (ex VQ-17) — Credenziale: campi cifrati, metadati del sito, generatore** (BLOCCANTE)
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
  - Base: `CredentialForm.tsx:120-153,207-211,251-275`; `CredentialCard.tsx:24-35,100`; `url-metadata.ts:116-150`; `note.service.ts:74,392-394`; `design:604`.
  - E2E: `vault-offline.spec.ts:41-58` copre coda e storage.

- [ ] **F.17 (ex VQ-18) — Copia di username e password, pulizia degli appunti dopo 30 s** (MEDIA)
  - Passi:
    1. "Copia password" e incolla.
    2. Resta sulla scheda 35 s e incolla.
    3. Ripeti passando subito a un'altra app.
    4. Win+V.
    5. Ripeti sul telefono.
  - Atteso:
    - Spunta per 2 s.
    - Con il focus: toast "Appunti cancellati" (`vault.credential.clipboardCleared`) e incolla vuoto.
    - Senza focus la pulizia fallisce in silenzio. La cronologia di Windows conserva la password: è un limite da dichiarare.
  - Base: `CopyButton.tsx:12-34`.

- [ ] **F.18 (ex VQ-19) — Ricerca e ordinamento nel vault; vault assente dalle ricerche globali** (ALTA)
  - Passi:
    1. Cerca `alfa`, poi `CORPO-SEGRETO-04`, `zeta-user`, `gamma`.
    2. Ordina per titolo. Usa i filtri Note e Credenziali.
    3. Ricerca globale e lista normale con gli stessi termini.
  - Atteso:
    - La ricerca ignora maiuscole e minuscole.
    - Il corpo di una NOTE non si trova: è voluto (§5.6).
    - Fuori dal vault nessun item vault, e nessun id vault in `/api/search`.
  - Non deve: richieste di rete mentre cerchi nel vault.
  - Base: `VaultPage.tsx:270-320`; `search.service.ts:40,70`; `useNotes.ts:28`.

- [ ] **F.19 (ex VQ-20) — Cronologia versioni: niente voci vault, restore di nv3 rifiutato** (MEDIA)
  - Prec.: N con più di 150 caratteri, modificata 3 volte a qualche minuto di distanza.
  - Passi:
    1. SQL sulle versioni: `nv3` e title `''`.
    2. Nell'header del vault non c'è la cronologia.
    3. "Togli dal vault", poi apri la cronologia (`notes.versions.title`).
    4. Restore manuale via S-API di una versione `nv3`.
  - Atteso:
    - Il modal non elenca voci `nv3`.
    - Il restore risponde 422 `errors.vault.plaintextRequired` e il contenuto non cambia.
  - Base: `VersionHistoryModal.tsx:29-39,67,83`; `noteVersion.service.ts:16,247-258,276`; `note.service.ts:407-414`; `vault.service.ts:559-563`.

- [ ] **F.20 (ex VQ-21) — Errori del server sulle scritture vault: plaintextRejected, stale, conflict** (ALTA)
  - Prec.: S-API caricato, `n = await get('<N>')`, `base = await sha(n.content)`. Annota epoch e length.
  - Passi:
    1. `put('<N>',{title:'IN-CHIARO'})` → 422 `plaintextRejected`.
    2. `put` con content `{"type":"doc",...}` e baseHash → 422 `plaintextRejected`.
    3. `put` con epoch+1 → 422 `errors.vault.stale`.
    4. `put` con un baseHash di soli zeri → 422 `errors.vault.conflict`.
    5. `put` con `{isEncrypted:false}` → 422 `plaintextRejected`.
    6. Controlla l'header di una risposta `/api/vault/*` e l'SQL.
  - Atteso:
    - DB invariato. `no-store` sulle risposte vault.
    - Testi in it.json: "Il vault è stato aggiornato su un altro dispositivo. Sbloccalo di nuovo e riprova."; "Questo contenuto non può essere salvato in chiaro nel vault.".
  - Non deve: 200; NoteVersion nuove.
  - Base: `vault.service.ts:49,70-84`; `note.service.ts:298-308,416-421`; `routes/vault.ts:83-84`; `it.json:1787,1791`.

- [ ] **F.21 (ex VQ-22, include S12) — Keyring non READY con modifiche in corso, e item vault:stale e vault:notReady seminati** (ALTA)
  - Prec.: solo DB dev; ripristina subito dopo.
  - Passi:
    1. In SQL imposta `status='RESET_PENDING'`. Scrivi ` NR1`: PUT 422 `errors.vault.notReady`, item `failed` con `lastError 'vault:notReady'`.
    2. Scrivi ` NR2`: nessuna PUT nuova (gli item sono trattenuti).
    3. Blocca: "Il vault non è disponibile al momento.".
    4. Rimetti `READY`, ricarica, sblocca, riapri e attendi il reconcile.
    5. Seed con S-SEED-CODA `('ID','vault:stale',true)`, poi "Controlla ora".
    6. Seed con `withTitle=false` e "Controlla ora" 3 volte.
    7. Scrivi `z`, chiudi, poi "Controlla ora".
    8. Ripeti i passi 5-7 con `vault:notReady`.
  - Atteso:
    - Passo 4: l'item si riattiva, PUT 200 con ` NR1 NR2`, coda vuota.
    - Passo 5: l'item torna pending SENZA title e viene chiuso come "skip" senza PUT. Coda vuota.
    - Passo 6: l'item resta `failed`. Compare "N elementi lasciati invariati. Cause possibili:" (`vault.settings.unresolved`) con tutte e 4 le righe `vault.settings.reason.*`, compresa "Nessuna modifica necessaria o già aggiornato.". Nessuna PUT.
    - Passo 7: PUT 200 e coda vuota.
  - Non deve: perdita di NR1 o NR2; item failed per sempre; loop di PUT; title in chiaro nel body; INVARIANTE diverso da 0.
  - Base: `syncService.ts:608-622,1000-1008,1375-1379,1461-1464`; `vaultReconcile.ts:127-143,268-271,452-470,838-846`; `VaultSettingsSheet.tsx:267-278`; piano `:992-995`.

- [ ] **F.22 (ex VQ-23) — Rete di sicurezza client: noteService rifiuta le scritture in chiaro su righe vault** (MEDIA)
  - Passi:
    1. In Vite dev: `const ns = await import('/src/features/notes/noteService.ts')`.
    2. `updateNote` con `{title}`, poi `{content:'{"type":"doc"}'}`, poi `{isVault:false}`.
  - Atteso: `VaultPlaintextGuardError` e `[noteService] scrittura vault rifiutata: <motivo>`. Dexie e coda invariati.
  - Base: `noteService.ts:112-123,167-179`.

- [ ] **F.23 (ex VQ-25) — Doppio clic sui pulsanti di creazione** (MEDIA)
  - Passi:
    1. Doppio clic su "Nuova Nota Sicura" nel pannello destro.
    2. Ripeti dal menu "+" e con "Nuova Credenziale".
  - Atteso:
    - Ideale: un solo item.
    - Probabile: due item "Senza titolo", validi e cifrati. È un difetto UX: `mutate` non ha la guardia `isPending`.
  - Non deve: item con title non vuoto o content non `nv3`.
  - Base: `VaultPage.tsx:222-250,619-626`.

---

## G. Offline

- [ ] **G.1 (ex SU-07) — Sblocco offline con la SPA già caricata (switch ON)** (ALTA)
  - Passi:
    1. "Blocca Vault", poi Offline.
    2. `X9kP4m`, poi PIN1.
    3. In "Banca A" metti la password `pw-offline-1` e attendi 2 s.
    4. Controlla la coda.
    5. Torna online.
  - Atteso:
    - PIN errato: "PIN errato", senza rete.
    - PIN1: toast. La modifica va in coda come `nv3` con title `''`, e `pw-offline-1` non compare in coda.
    - Online la push invia l'envelope.
  - Base: `VaultUnlock.tsx:69`; `vaultSession.ts:295-335`.
  - E2E: `vault-offline.spec.ts:12-58`. Il manuale serve sul telefono, in modalità aereo.

- [ ] **G.2 (ex SU-08) — Reload senza server, poi sblocco offline (parte dev; la preview è in K.3)** (ALTA)
  - Passi: Request blocking `*/api/*`, ricarica /vault, inserisci PIN1. Poi togli il blocco.
  - Atteso:
    - "Vault Bloccato" (READY dalla cache), non "Sei offline".
    - La richiesta fallisce con status 0, poi parte `unlockOffline`.
  - Non deve: setup; purge; "Qualcosa è andato storto".
  - Base: `VaultPage.tsx:129-135`; `VaultUnlock.tsx:17-20,68-78`.
  - E2E: sì, `vault-offline.spec.ts:9-10`.

- [ ] **G.3 (ex SU-09, include SEC-01) — Switch "Sblocco offline" in Impostazioni: OFF subito, ON dal prossimo sblocco online** (ALTA)
  - Prec.: R1 con lo share. Ripeti sul telefono o su Edge.
  - Passi:
    1. Impostazioni, Vault: titolo, "Sblocca il vault su questo dispositivo anche senza connessione." e, con ON, "Vale dal prossimo sblocco online.".
    2. OFF: controlla `byUser` e `shares`.
    3. Offline senza reload: PIN1.
    4. Online con le API bloccate: reload e PIN1.
    5. ON, senza sbloccare: `shares`.
    6. Sblocco online, poi `shares`.
    7. Offline: blocca e risblocca.
    8. Browser nuovo appena loggato: Impostazioni.
    9. TalkBack o VoiceOver sullo switch.
  - Atteso:
    - OFF: `offlineUnlock:false`, niente `wrappedVkPin`, niente share. `deviceKeys` resta.
    - Offline: "Lo sblocco offline non è disponibile su questo dispositivo. Connettiti a internet e riprova." (`errors.vault.offlineUnavailable`).
    - Reload con le API bloccate: "Errore di rete…", senza ripiego.
    - ON prima dello sblocco: `shares` ancora vuoto. Dopo lo sblocco online lo share c'è e lo sblocco offline funziona.
    - Browser nuovo: nessuno switch e nessun "Rimuovi".
    - `aria-checked` corretto, area di tocco di almeno 44 px.
  - Non deve: share o `wrappedVkPin` residui dopo OFF; switch che torna ON da solo.
  - Base: `VaultSettingsSection.tsx:54-56,84-104`; `vaultSession.ts:283-284,297-305,338-341`; `vaultStore.ts:141-148`.
  - E2E: `vault-offline.spec.ts:68-137`.

- [ ] **G.4 (nuova) — kdfParams manomessi nella cache locale (accettazione 10)** (MEDIA)
  - Prec.: R1 con offline ON, sbloccato una volta online su questo browser.
  - Passi:
    1. In Console:
       ```js
       const uid=JSON.parse(localStorage.getItem('auth-storage')).state.user.id; const s=JSON.parse(localStorage.getItem('vault-storage')); s.state.byUser[uid].kdfParams.t=4; localStorage.setItem('vault-storage',JSON.stringify(s));
       ```
       Poi ricarica, perché lo store si reidrata al boot.
    2. Offline, poi PIN1.
    3. Ripeti con `kdfParams.m=1024` al posto di t.
    4. Online, sblocco con PIN1. Poi controlla `byUser[uid].kdfParams`.
  - Atteso:
    - Passo 2: "PIN errato". L'unwrap fallisce, perché `kdfCanon` fa parte dell'AAD.
    - Passo 3, da osservare: `deriveS` rifiuta i parametri e compare "Qualcosa è andato storto. Riprova.", oppure "PIN errato".
    - Passo 4: lo sblocco online riesce e la cache torna a `{m:65536,t:3,p:1}`, riscritta dal server.
  - Non deve: sblocco riuscito con i parametri manomessi; contatore del DB incrementato dai tentativi offline; cache o share cancellati.
  - Base: `vaultSession.ts:124-127,279,307-322`; piano `:316-317`.

- [ ] **G.5 (ex S04) — Android offline: più edit e una nota creata offline, nessun falso conflitto (T9)** (ALTA)
  - Passi:
    1. DevTools remoti, Offline.
    2. Nella nota S04 fai 3 edit a 3 s l'uno dall'altro (`e1`, `e2`, `e3`).
    3. Crea la nota "S04-nuova" con corpo `n1`.
    4. Blocca e sblocca offline, poi `nq()`.
    5. Torna online e attendi 30 s.
    6. Dal PC: `sq()`.
  - Atteso:
    - Nessuna copia. S04 = `e3`. S04-nuova presente una volta sola. Coda vuota.
    - Gli UPDATE successivi vengono chiusi come "skip", senza chiamata.
  - Non deve: PUT 422; duplicati.
  - Base: `syncService.ts:608-622,1392-1416`; `vaultReconcile.ts:219-230`.
  - E2E: il caso su PC è coperto (`vault-conflict`, test 2).

---

## H. Multi-device, sync e conflitti

Per ogni scenario: A in una finestra normale, B in incognito, stesso utente. Usa note nuove con un titolo univoco. "Controlla ora" si trova in Impostazioni vault (`vault.settings.checkButton`).

I trigger del reconcile (`VaultPage.tsx:164-182`):
- sblocco online;
- evento online;
- chiusura di una nota, se sei online;
- "Controlla ora".

La push parte quando cambia la coda e con il tick di 30 s. La CAS fallita appare come PUT 422 `errors.vault.conflict`.

- [ ] **H.1 (ex S01) — Conflitto vero: A offline, B online, editor di A chiuso. Una copia, nessuna perdita** (BLOCCANTE)
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
  - Ispeziona: se vedi una PUT 422 senza copia, la push ha battuto il reconcile e la nota è in LATER per `listSig` (backlog di HANDOFF §4.2). Si sblocca aprendo e chiudendo la nota o con "Controlla ora". Annotalo.
  - Base: `vaultReconcile.ts:273-281,401-404,422,482-495,537-543,831`; `VaultPage.tsx:170-175`; `useSync.ts:97-101`.
  - E2E: `vault-conflict`, test 3 (credenziale).

- [ ] **H.2 (ex S02) — Variante con editor aperto (flake noto del test 1): A scrive di nuovo durante il conflitto** (BLOCCANTE)
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
  - Ispeziona:
    - Se l'hash di riga dell'originale è uguale a quello del server, il difetto è di UI (ri-decifratura del form o liveQuery vecchia).
    - Se è diverso, cerca una PUT o POST tardiva sull'originale, `[vaultReconcile] nota lasciata invariata`, e un UPDATE ricomparso dal cleanup del form.
  - Base: HANDOFF §4.2; `CredentialForm.tsx:85-118,157-167,366-401`; `VaultNoteEditor.tsx:117-157`; `vaultReconcile.ts:263-267,855-858`; `syncService.ts:1006-1012`.
  - E2E: test 1 (instabile 1 volta su 6).

- [ ] **H.3 (ex S03) — Concorrenza con tutti e due online: vault:conflict, banner e Riprova, edit trattenuti** (ALTA)
  - Passi:
    1. S03 aperta su entrambi. B: `B1`.
    2. A: `A1`, PUT 422.
    3. A: toast `sync.failedToast`, banner, "Riprova" (`sync.retry`).
    4. A: `A2`, `A3` per 2 minuti, con `sq` e `nq` ogni tanto.
    5. A: seleziona un'altra nota.
    6. Variante: A va su Note (il vault si blocca), torna e sblocca.
  - Atteso:
    - "Riprova" non cambia nulla (`syncService.ts:1464`): l'item resta `failed`, i successivi restano pending, il server resta su `B1`.
    - Dopo il trigger: 1 copia con `A3`, originale `B1`, coda vuota.
    - Annota quanto restano fermi gli edit, e se il Riprova inefficace confonde.
    - Da decidere: `sync.failedToast` dice "Alcune modifiche non sono state sincronizzate. Usa Riprova nella barra di sincronizzazione." (`it.json:976`), ma per gli item `vault:*` Riprova non fa nulla. Il piano §12.11 (`:738`) chiede che il testo lo dica.
  - Non deve: server sovrascritto; A2 o A3 persi; loop di PUT.
  - Base: `syncService.ts:1006-1012,1374-1380,1461-1464`; `SyncStatusIndicator.tsx:27-84`; `VaultPage.tsx:177-182,351-355`.

- [ ] **H.4 (ex S05) — Risposta persa: PUT 2xx arrivata al server ma non al client (T2 ACK, replay idempotente)** (ALTA)
  - Prec.: offline ON. S05 con `v0`.
  - Passi:
    1. **Variante A**: breakpoint XHR su `readystatechange`/`loadend`. Scrivi `v1`. In pausa sulla risposta 200 della PUT, premi F5.
    2. Subito `nq`: pending, `sent` contiene h1, base h0. Attendi la push al mount (gira anche a vault bloccato). Poi `nq` e `sq`.
    3. **Variante B**: come A, ma prima di F5 blocca `*/api/*`. Sblocca offline e scrivi `v2`.
    4. **B1**: editor chiuso, togli il blocco, poi Offline e Online.
    5. **B2**: editor aperto, tick di 30 s (422), poi Indietro.
    6. `nq`, `sq`, "Controlla ora".
    7. Alternativa ai breakpoint: latenza di 10000 ms. L'SQL mostra già `v1` mentre la PUT è pending; poi F5.
  - Atteso:
    - A: il replay con la base vecchia risponde 200. Base h1, `sent=[]`, nessuna copia.
    - B1: T4 aggiorna la base senza accodare, poi la PUT di `v2` risponde 200.
    - B2: 422, poi T2 ACK alla chiusura, poi PUT 200.
    - In ogni caso: server = ultimo valore, nessuna copia, `sent` ridotta per prefisso.
  - Non deve: copia; ritorno a `v0`; edit persi.
  - Base: `syncService.ts:1060-1072,1217-1233,1392-1416`; `vault.service.ts:80-83`; `vaultReconcile.ts:264,276-280`.

- [ ] **H.5 (ex S06) — Rete che cade a metà reconcile e scheda chiusa subito dopo la copia** (BLOCCANTE)
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
  - Base: `vaultReconcile.ts:482-516,717-737,753-762`; `VaultPage.tsx:164-168`.

- [ ] **H.6 (ex S07) — Backend ucciso a metà invece della rete assente: niente evento online, backoff, Riprova** (ALTA)
  - Passi:
    1. `k1` arriva al server. Ctrl+C sul backend.
    2. Scrivi `k2`, Indietro. Annota il codice della PUT (status 0 se diretto, 500 se dal proxy: vedi P0.1).
    3. "Controlla ora": `errors.common.unknownError`.
    4. `nq` ogni minuto per 5 minuti.
    5. Riavvia con `'*'`. Attendi 30 s e, se l'item è `failed`, clicca "Riprova".
    6. Variante: prima del Riprova, B cambia S07 in `B7`.
  - Atteso:
    - Backoff 5/15/45/135 s, poi `failed` con il banner. Se invece il proxy chiude il socket, `attempts` resta fermo.
    - Dopo il Riprova: PUT 200, coda vuota.
    - Variante: 422, poi la copia al trigger successivo (il riavvio non fa scattare l'evento online).
  - Non deve: `k2` perso; copia senza conflitto.
  - Base: `syncService.ts:801-819,1392-1421,1448-1473`; `VaultPage.tsx:170-175`; `VaultSettingsSheet.tsx:145-151`.
  - Limite: in prod si vede il 502 di IIS.

- [ ] **H.7 (ex S08) — Web Locks fra schede: editor in T1, reconcile in T2, lock del giro tenuto da una scheda ferma** (ALTA)
  - Passi:
    1. T1 apre S08. In T2 il lock shared è tenuto.
    2. B: `B8`. T2: "Controlla ora".
    3. T1: Indietro. T2: "Controlla ora", poi apri.
    4. **Giro sospeso**: in T1 metti un breakpoint a `vaultReconcile.ts:857` e fai "Controlla ora". In T2 "Controlla ora" deve restare in attesa su `notiq-vault-reconcile`.
    5. F8 in T1. Ripeti chiudendo T1 mentre è in pausa.
  - Atteso:
    - Passo 2: "N elementi verranno aggiornati più tardi." (`vault.settings.later`) e riga invariata.
    - Passo 3: "Tutto aggiornato." e `B8`.
    - Passo 5: T2 attende senza errori e completa al rilascio. Nessuna copia.
    - Annota che "Controlla ora" non ha timeout.
  - Non deve: riga riscritta sotto l'editor aperto; lock rimasto dopo la chiusura.
  - Base: `vaultNoteLock.ts:25-66`; `vaultReconcile.ts:699-711,855-859`; `VaultSettingsSheet.tsx:145-153`.

- [ ] **H.8 (ex S09, include VQ-06) — Stessa nota in due schede dello stesso profilo: nessuna copia spuria, vince l'ultimo che scrive** (ALTA)
  - Passi:
    1. T1: `t1`, 3 s.
    2. T2 (aperta prima): annota cosa mostra, poi `t2`, 3 s.
    3. T1: `t1b`, 3 s.
    4. Chiudi entrambe e attendi 30 s. `nq`, `sq`, "Controlla ora". Query delle versioni.
  - Atteso:
    - Nessuna copia, nessun 422 ripetuto. Vince l'ultima scrittura locale (T1, quindi `t2` sparisce), come prima di P2.
    - Da decidere: è una perdita silenziosa fra schede. Accettarla, oppure aggiungere un avviso.
  - Non deve: "(copia in conflitto)"; loop di 422; riga illeggibile.
  - Base: spec T15 (c) e T3; `vaultReconcile.ts:265`; `syncService.ts:614-621,1062-1072,1219-1233`; `VaultNoteEditor.tsx:117-157`.

- [ ] **H.9 (ex S10) — Flip della pull sotto lock: B toglie la nota dal vault mentre A la tiene aperta** (ALTA)
  - Passi:
    1. A apre S10 (`base`).
    2. B: "Togli dal vault" (`notes.removeFromVault`), conferma (`vault.exitTitle`), toast.
    3. A: attendi 60 s. `nq`: la nota è ancora `isVault`.
    4. A: `A10`, 3 s: PUT 422 `errors.vault.plaintextRequired`.
    5. A: Indietro, 30 s, poi controlla Note e vault.
    6. Variante senza scrittura.
  - Atteso:
    - Il flip viene rimandato finché A tiene aperta la nota.
    - Poi S10 esce dal vault di A. Nel vault compare "S10 (copia in conflitto)" con `A10`. S10 è fra le note normali con `base`.
    - Server: in chiaro e invariato. Variante: nessuna copia.
  - Non deve: envelope sul server; "nv3." mostrato in una nota normale; `A10` perso; editor smontato mentre scrivi.
  - Base: `syncService.ts:197-232`; `note.service.ts:310-313`; `vaultReconcile.ts:205`; `VaultPage.tsx:330-338`.

- [ ] **H.10 (ex S11) — B elimina definitivamente la nota mentre A ha edit offline (T10)** (ALTA)
  - Passi:
    1. A offline: `A11`, Indietro.
    2. B elimina la nota (`vault.deletePermanently`).
    3. A online, 30 s. Se la copia non compare, apri e chiudi una nota.
    4. `nq`, `sq`, `sq(['ID'])`.
  - Atteso:
    - S11 sparisce. Compare "S11 (copia in conflitto)" con `A11`. S11 risulta `absent`.
    - Se il reconcile arriva prima: `absent`, COPY + DROP.
    - Se la push arriva prima: la PUT 404 scarta l'UPDATE (`syncService.ts:1334`), poi la copia arriva al trigger.
  - Non deve: `A11` perso; S11 ricreata col vecchio id.
  - Base: `vaultReconcile.ts:219-222,717-737`; `syncService.ts:1334-1345`.

- [ ] **H.11 (ex S13) — Browser senza navigator.locks: solo operazioni sicure** (MEDIA)
  - Prec.: A ricaricato e non sbloccato. In Console: `Object.defineProperty(navigator,'locks',{configurable:true,value:undefined})`.
  - Passi:
    1. B cambia S13. A sblocca e fa "Controlla ora".
    2. Apri S13 e una credenziale.
    3. Conflitto su S13b come in H.1. Attendi 30 s, "Controlla ora", `nq`.
    4. Reload (l'override sparisce) e sblocco.
  - Atteso:
    - "N elementi verranno aggiornati più tardi.".
    - Gli editor si aprono: la nota mostra la versione di B, la credenziale non resta in caricamento infinito.
    - Conflitto: nessuna copia, item `failed` `vault:conflict`, edit di A conservati in Dexie.
    - Col lock: 1 copia e tutto allineato.
  - Non deve: copia o DROP senza lock; editor fermi.
  - Base: `vaultReconcile.ts:160-169,855,859`; `vaultNoteLock.ts:15-18`; `syncService.ts:231`; `CredentialForm.tsx:390`; `VaultNoteEditor.tsx:150`.

- [ ] **H.12 (ex S16) — Trigger, single-flight e rate limit** (MEDIA)
  - Passi:
    1. Blocca e sblocca: conta i giri.
    2. Doppio clic su "Controlla ora".
    3. Offline e online 5 volte di fila.
    4. 25 aperture e chiusure in meno di un minuto.
    5. Con un conflitto pendente: online, subito doppio "Controlla ora", apri e chiudi.
    6. Offline: chiudi una nota, poi torna online.
  - Atteso:
    - Un giro; al massimo 2 sequenze sovrapposte.
    - Prima o poi arriva un 429 su `/vault/items`, ma le note si aprono con la copia locale, senza toast, e dopo un minuto tutto riprende.
    - 1 sola copia. Nessuna richiesta da offline.
  - Base: `vaultReconcile.ts:648-694,753-762`; `VaultPage.tsx:164-182`; `routes/vault.ts:130`; `VaultNoteEditor.tsx:125`.

- [ ] **H.13 (ex S17) — Credenziale aperta su A dopo un edit di B, senza trigger in mezzo** (ALTA)
  - Passi:
    1. B cambia S17 in `pw-B`.
    2. A, entro 30 s, apre S17 e annota il valore.
    3. Ripeti con la nota S17n (`nB`).
    4. Se A vede `pw-0`, cambialo in `pw-A`, attendi 40 s e chiudi.
  - Atteso:
    - Dal codice: la credenziale mostra `pw-0` (il vecchio valore: all'apertura non parte nessuna POST `/vault/items`). La nota mostra `nB`.
    - Se A modifica: 422, poi 1 copia con `pw-A` e l'originale con `pw-B`.
    - Nessuna perdita, ma è un conflitto evitabile: segnalalo come UX.
  - Base: `VaultPage.tsx:340-348`; `CredentialForm.tsx:85-118`; `VaultNoteEditor.tsx:122-126`; `vaultReconcile.ts:624-642`.

- [ ] **H.14 (ex SU-21, include SEC-03) — Più schede: chiavi per scheda, blocco, logout, rimozione, clear e removeItem in un'altra scheda** (ALTA)
  - Passi:
    1. S1 sblocca. S2 apre /vault.
    2. S2 sblocca. S1 clicca "Blocca Vault": guarda S2.
    3. Risblocca S1. Logout da S2: guarda S1.
    4. Login in S2 con S1 sbloccata. S2: "Rimuovi vault da questo dispositivo" e conferma. Guarda S1.
    5. In S1 interagisci e blocca. Ricontrolla `vault-storage`: `byUser` è ricomparso?
    6. Risblocca S1. In S2: `localStorage.removeItem('vault-storage')`. Guarda S1.
    7. In S2: `localStorage.clear()`.
  - Atteso:
    - S2 chiede il PIN. Il blocco di S1 NON blocca S2.
    - Il logout in S2 blocca S1. S1 resta loggata in memoria: annotalo.
    - La rimozione blocca S1 e cancella share e deviceKeys.
    - Passo 5, da osservare: se `byUser` ricompare senza share, è un residuo innocuo da documentare (HANDOFF §5).
    - Passo 6: S1 resta sbloccata. La rehydrate con `null` non cambia lo stato: è un residuo accettato (piano `:966`, HANDOFF `:122`).
    - Passo 7: `clear()` blocca S1.
  - Non deve: una scheda sbloccata dopo logout, rimozione o clear altrove; rimozione con item in coda (deve comparire `vault.settings.removeBlocked`).
  - Base: `vaultStore.ts:149-156,174-176,182-204`; `vaultSession.ts:508-521`; `VaultSettingsSection.tsx:21-38,58-78`.

- [ ] **H.15 (ex SU-22) — Rollout simulato: un bundle vecchio in un'altra scheda riscrive vault-storage senza byUser** (ALTA)
  - Passi:
    1. In S2: `localStorage.setItem('vault-storage', JSON.stringify({state:{isSetup:true,pinHash:null},version:0}))`.
    2. Guarda S1 e lo storage. In S1 clicca "Blocca Vault" e ricontrolla.
    3. Ripeti il passo 1, poi chiudi S1 e S2.
    4. In una scheda nuova, con le API bloccate, apri /vault.
    5. Togli il blocco, sblocca online, guarda lo switch e `shares`.
  - Atteso:
    - S1 non si blocca (merge superficiale).
    - Al primo set di S1 `byUser` torna.
    - Se tutte le schede si chiudono prima: "Sei offline" (UNKNOWN).
    - Dopo lo sblocco online: `offlineUnlock:false` e share cancellato. L'handoff non lo dice: decidi se metterlo nel runbook.
  - Non deve: setup; purge; note perse.
  - Base: `vaultStore.ts:187-193`; `vaultSession.ts:276,284`; piano `:967`; HANDOFF §5.
  - Limite: è una simulazione. Il caso reale si vede solo durante il deploy.

---

## I. Spostamenti dentro e fuori dal vault

Nessun E2E copre moveIn e moveOut.

- [ ] **I.1 (ex IN-01) — Sposta DENTRO una nota normale: testo appena scritto incluso, cifratura e versioni** (BLOCCANTE)
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
  - Base: `NoteEditor.tsx:387-437,787,906-911`; `vaultMove.ts:174-263`; `note.service.ts:283-288,396-414`; `NotesPage.tsx:82-87`.

- [ ] **I.2 (ex IN-02) — Sposta DENTRO una nota condivisa e pubblica con collaborazione live** (BLOCCANTE)
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
  - Base: `note.service.ts:234-245,343-345,396-401`; `NoteEditor.tsx:399,415-417,787`; HANDOFF §5.

- [ ] **I.3 (ex IN-03) — Ingresso secondo lo stato del keyring: NONE, legacy, READY bloccato** (ALTA)
  - Passi:
    1. Utente senza keyring: scrivi `MK-U1` e subito "Aggiungi al Vault".
    2. Utente legacy NONE: stessa prova.
    3. READY bloccato: nel sheet del PIN prova `X9kP4m`, poi PIN1. Variante: chiudi il sheet.
  - Atteso:
    - NONE: /vault con il setup, nota normale con `MK-U1`.
    - Legacy: "Aggiorna il tuo vault", nota normale.
    - READY: errore col PIN sbagliato, poi come I.1. Se chiudi il sheet, la nota resta normale.
  - Non deve: PUT con `isVault` senza sblocco.
  - Base: `vaultMove.ts:131-140`; `NoteEditor.tsx:439-453,994,997`.

- [ ] **I.4 (ex IN-04) — Errori dell'ingresso: coda pending, item failed, offline, server irraggiungibile, allegati** (ALTA)
  - Passi:
    1. Blocca `api/notes*` (host secondo P0.1), scrivi `MK-PEND` e "Aggiungi". Dopo circa 5 s leggi il toast. Togli il blocco e riprova.
    2. S-SEED-CODA con `{isPinned:true}`, `failed`, `validation`, poi "Aggiungi".
    3. Offline.
    4. Blocca `api/notes/*` dopo che la coda si è svuotata.
    5. Nota con allegato.
  - Atteso:
    1. "La nota è ancora in sincronizzazione. Riprova tra poco."; il secondo tentativo riesce.
    2. "Alcune modifiche a questa nota non sono state sincronizzate. Risolvile e riprova.".
    3. Comando disabilitato, tooltip "Per spostare una nota nel vault serve la connessione.".
    4. Lo stesso testo, come toast.
    5. "gli allegati non sono consentiti nelle note del vault cifrato" (`errors.vault.attachmentsBlocked`; annota l'iniziale minuscola) e nessuna PUT.
  - Non deve: nota spostata a metà; testo perso; editor congelato.
  - Base: `vaultMove.ts:23-31,142-165,195`; `NoteEditor.tsx:427-433,441-442,457`.

- [ ] **I.5 (ex IN-05) — Conflitto durante l'ingresso: ritentativo automatico ed esaurimento** (ALTA)
  - Passi:
    1. A con un breakpoint su `/notes/`, fino alla PUT con `isVault`.
    2. In pausa, B scrive `MK-B1` e sincronizza.
    3. Riprendi: 422, poi una seconda GET, poi la PUT.
    4. Esaurimento: B modifica la nota prima di ognuna delle 3 PUT.
  - Atteso:
    - Primo caso: il vault contiene `MK-B1`.
    - Esaurimento: dopo 3 PUT 422 compare "La nota è cambiata sul server. Riprova." e la nota resta normale.
  - Non deve: envelope del contenuto vecchio; più di 3 PUT; revoca ripetuta.
  - Base: `vaultMove.ts:144,188-224`; `note.service.ts:286,418-420`.

- [ ] **I.6 (ex IN-06) — Editor congelato, rimontaggio e doppio clic durante lo spostamento** (ALTA)
  - Passi:
    1. N1 con Slow 3G: doppio clic su "Aggiungi".
    2. Durante lo spostamento passa a N2, poi torna a N1.
    3. Prova testo, stella, promemoria e cestino.
    4. Attendi il commit.
  - Atteso:
    - Una sola sequenza GET + PUT.
    - L'istanza rimontata è congelata.
    - Dopo il commit N1 si chiude e N2 resta intatta. Un solo toast.
  - Non deve: UPDATE in chiaro accodati.
  - Base: `vaultMove.ts:35-56,174-181`; `NoteEditor.tsx:96-108,406-408,420`; `NotesPage.tsx:82-87`.

- [ ] **I.7 (ex IN-07) — Risposta della PUT persa dopo che il server l'ha applicata** (MEDIA)
  - Passi:
    1. Latenza di 8000 ms, "Aggiungi". Con la PUT pending, Offline.
    2. Al toast, scrivi `MK-AFTER-DROP`.
    3. Online, Q6, /vault e reconcile.
  - Atteso:
    - Se il server l'ha applicata: 422 `plaintextRejected`, poi 1 copia nel vault con `MK-AFTER-DROP` (T12).
    - Altrimenti la nota resta normale, col testo.
    - Se non riesci a riprodurlo, annota "non riprodotto", non "passato".
  - Base: `vaultMove.ts:216-224`; spec T15 T12; `syncService.ts:228`.

- [ ] **I.8 (ex OUT-01) — Togli dal vault: chiaro sul server, ricerca, cronologia, dispositivo B offline** (BLOCCANTE)
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
  - Base: `vaultMove.ts:64-121`; `VaultNoteEditor.tsx:206-234,316-326`; `note.service.ts:289-297,403-405`; `syncService.ts:223-232`.

- [ ] **I.9 (ex OUT-02) — Togli dal vault con un conflitto** (ALTA)
  - Passi:
    1. B scrive `MK-B-EDIT`.
    2. A, senza reload: "Rimuovi" e "Conferma".
    3. Riapri dopo 5-10 s e riprova.
  - Atteso:
    - 422 e "La nota è cambiata su un altro dispositivo. È stata aggiornata: riprova.". L'editor si chiude.
    - La riapertura mostra `MK-B-EDIT`. Il secondo tentativo riesce.
  - Non deve: sovrascrittura; copia senza modifiche; retry automatico.
  - Base: `vaultMove.ts:93,96-100`; `VaultNoteEditor.tsx:225-230`; `note.service.ts:294-296`.

- [ ] **I.10 (ex OUT-03) — Editor del vault aperto su B mentre A toglie la nota** (ALTA)
  - Passi: A toglie la nota. B continua a scrivere `MK-B-LATE` per circa 5 s, poi Indietro e reconcile.
  - Atteso:
    - Server in chiaro, senza `MK-B-LATE`.
    - Su B: PUT 422 `plaintextRequired`, poi 1 copia nel vault con `MK-B-LATE`. Coda vuota.
  - Base: `note.service.ts:310-313`; spec T15 T13; `syncService.ts:225-232`.

- [ ] **I.11 (ex OUT-04) — "Togli dal vault": offline, credenziali, server irraggiungibile** (MEDIA)
  - Atteso:
    - Offline: comando disabilitato, "Devi essere online per togliere una nota dal vault.".
    - Credenziale: il comando non c'è.
    - Server irraggiungibile: lo stesso testo, come toast. L'editor torna modificabile e le modifiche restano. `isVault` resta true in Dexie.
    - Il caso keyring non pronto (`vault.moveOut.notReady`) è in A.8.
  - Base: `VaultNoteEditor.tsx:221-233,244,316-326`; `vaultMove.ts:23-31,90`.

---

## J. Impostazioni vault e cambio PIN

- [ ] **J.1 (ex SET-01) — Cambio PIN dal VaultSettingsSheet: percorso felice, nessun segreto in rete, Kit invariato** (BLOCCANTE)
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
  - Base: `vaultSession.ts:359-415`; `VaultSettingsSheet.tsx:108-125,217`; `vault.service.ts:321-370`; `it.json:641-647`.

- [ ] **J.2 (ex SET-02) — Cambio PIN: PIN attuale errato, policy, conferma, offline, rete giù, lockout** (ALTA)
  - Passi:
    1. PIN attuale `K7rQ2X`.
    2. Nuovo PIN `123456`.
    3. Conferma diversa.
    4. Offline col foglio aperto, poi online.
    5. Blocca `*/api/vault/*` e invia.
    6. Arriva al 6° errore cumulato, poi fai il 7°. Azzera.
  - Atteso:
    1. "PIN errato", `failedAttempts` +1, nessuna PUT.
    2. `vault.pinPolicy.*`, nessuna chiamata di rete.
    3. "I PIN non corrispondono".
    4. Banner "Sei offline: cambio PIN e Kit richiedono la connessione.", pulsanti disabilitati e riattivati online senza reload.
    5. "Errore di rete…".
    6. Il 6° dà ancora "PIN errato", e `lockedUntil` diventa +15 min. Il 7° dà subito `errors.vault.locked`, senza Argon2.
  - Non deve: PUT dopo un errore; `rev` incrementato; marker residuo; chiavi i18n grezze.
  - Base: `VaultSettingsSheet.tsx:110-114,171,201-206,219`; `vaultSession.ts:115-164`; `vaultApi.ts:50-57`.

- [ ] **J.3 (ex SET-03) — Cambio PIN interrotto: marker pin e toast al riavvio (pinNotApplied e pinApplied)** (ALTA)
  - Passi:
    1. Breakpoint `vault/keyring`. F8 sulla GET, pausa sulla PUT.
    2. Controlla `pending`: `<userId>:pin {kind:'pin',rev,wrappedVkPinHash}`.
    3. Offline e F8: "Errore di rete…", e il marker resta.
    4. Ricarica e sblocca col PIN VECCHIO.
    5. Variante: chiudi la scheda durante la pausa.
    6. Variante pinApplied (tentativo): throttling a 4000 ms, "Cambia PIN". Chiudi la scheda appena la PUT risulta inviata (Waterfall: "Request sent"). Riapri e sblocca col PIN NUOVO.
  - Atteso:
    - Passi 4-5: toast "Vale ancora il PIN precedente." (`vault.pendingPinNotApplied`) e il marker sparisce. Il PIN nuovo non vale. `rev` invariato.
    - Passo 6: toast "Il nuovo PIN è attivo." (`vault.pendingPinApplied`) e il marker sparisce. Se il server non ha ricevuto la PUT, vedi il caso dei passi 4-5: annota "non riprodotto".
    - Il marker contiene solo kind, rev e hash.
  - Non deve: toast a ogni sblocco successivo.
  - Base: `vaultSession.ts:392-409,483-502`; `VaultPage.tsx:185-197`; `deviceKeyStore.ts:19-21,114-118`; `it.json:523-524`.

- [ ] **J.4 (ex SET-04) — Doppio invio del cambio PIN** (MEDIA)
  - Prec.: pagina appena ricaricata (blocklist non ancora caricata).
  - Passi: doppio clic su "Cambia PIN" o doppio Invio. Conta le POST `/unlock` e le PUT.
  - Atteso:
    - Risultato corretto e al massimo un errore visibile.
    - Se partono 2 PUT, la seconda prende 409 `staleRev` e ritenta. L'esito è lo stesso, ma è un difetto minore: `pinBusy` viene impostato dopo `await checkPin`.
  - Base: `VaultSettingsSheet.tsx:108-116`; `PinPolicy.ts:72`; `vaultSession.ts:389-411`.

- [ ] **J.5 (ex CROSS-01, include SU-23) — Cambio PIN sul PC: B offline accetta il vecchio PIN, online il nuovo (manuale 2)** (BLOCCANTE)
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
  - Base: `vaultSession.ts:275-292,295-335,359-415`; piano §5.4 e §10; HANDOFF `:95`.

- [ ] **J.6 (ex CROSS-02) — Il vecchio PIN resta valido offline fino al prossimo sblocco ONLINE** (MEDIA)
  - Passi:
    1. Riparti da J.5 dopo il passo 4: B resta online e sbloccato per 1 minuto.
    2. Blocca e vai SUBITO offline.
    3. PIN1.
  - Atteso:
    - Dal codice B sblocca: la cache non si aggiorna al ritorno online, perché VaultPage non chiama `cacheKeyring`.
    - Da decidere: correggere il testo "finché non torna online" (`it.json:647`) oppure il codice.
  - Base: `vaultSession.ts:74-89`; `VaultPage.tsx:119-139`; `en.json:548`.

- [ ] **J.7 (ex SEC-02) — "Rimuovi vault da questo dispositivo": guardia su righe e coda, poi rimozione completa** (BLOCCANTE)
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
  - Base: `VaultSettingsSection.tsx:21-38,58-78,110-116,133-142`; `vaultSession.ts:344-347`; `deviceKeyStore.ts:121-126`; `vaultStore.ts:149-156`; `VaultPage.tsx:129-135,350-355,400`.
  - Limite: un item `failed` `vault:*` blocca la rimozione. È coperto dagli unit test.

- [ ] **J.8 (ex SEC-04) — Doppio clic su "Rimuovi" e sulla conferma; testi della sezione** (MEDIA)
  - Atteso:
    - Un solo dialog (ConfirmDialog, mai `window.confirm`) e un solo toast (al massimo 2, senza errori).
    - I 4 punti di "Come funziona" sono coerenti con P2: il recupero col Kit arriverà dopo.
    - Il link "Cambia PIN / Kit di recupero" porta a /vault.
  - Base: `VaultSettingsSection.tsx:58-78,121-130`; `ConfirmDialog.tsx:35-41`; `en.json:584-591`.

- [ ] **J.9 (ex SET-06) — "Controlla ora": esiti, doppio clic, chiusura durante il controllo** (MEDIA)
  - Atteso:
    - Utente aggiornato: "Tutto aggiornato.".
    - Doppio clic: un solo controllo, oppure "Un altro controllo è già in corso: riprova tra poco." (`vault.settings.skipped.busy`).
    - Chiudi e riapri: nessun esito vecchio.
    - Con legacy residuo: riquadro ambra "N elementi da aggiornare.", e l'azione chiude il foglio mostrando il banner.
  - Base: `VaultSettingsSheet.tsx:74,78-82,145-152,238-279`; `VaultPage.tsx:419-426`.

---

## K. Build di prod e cache del Service Worker

Si lavora su :4173, con la build di P0.11.

- [ ] **K.1 (ex SW-01, include VQ-27) — api-cache senza /api/vault/ né /api/notes/<id> (manuale 5)** (BLOCCANTE)
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
  - Base: `vite.config.ts:59-79` (predicato `:67`); `routes/vault.ts:83-86`; `vaultApi.ts:136-138`; piano §10 manuale 5, §5.5.
  - E2E: no (solo l'unit T12).

- [ ] **K.2 (ex SW-02) — Logout e sblocco online svuotano api-cache** (BLOCCANTE)
  - Passi:
    1. Logout, poi Refresh Caches sulla pagina di login.
    2. Login, ripopola la cache, sblocco online e subito Refresh.
  - Atteso:
    - Dopo il logout `api-cache` non c'è. Se rinasce per una GET della pagina di login, deve contenere solo endpoint pubblici: annota l'URL.
    - Allo sblocco online viene cancellata (`vaultSession.ts:287`).
  - Non deve: liste dell'utente precedente.
  - Base: `authStore.ts:75-83`; `apiCache.ts:4-11`; `vaultSession.ts:257,287`.
  - Da osservare: la gara fra il purge e una GET NetworkFirst in volo.

- [ ] **K.3 (ex SW-03, include la parte preview di SU-08) — Reload offline vero, sblocco offline con il Worker dalla precache, edit in coda** (ALTA)
  - Prec.: sblocco online già fatto su :4173 con offline ON. Nessuna pagina vault aperta in questa sessione.
  - Passi:
    1. Offline in entrambi i punti (SW e Network).
    2. Ricarica /notes, poi /vault.
    3. Inserisci il PIN.
    4. Modifica la nota sicura con `offline-prod-1`.
    5. Controlla la coda.
    6. Torna online.
  - Atteso:
    - La SPA si carica (navigateFallback).
    - Lo sblocco offline riesce. `argon2.worker-*.js` viene servito dal "(ServiceWorker)".
    - In coda c'è `nv3` con title `''`.
    - Online la coda si svuota e il server ha l'envelope nuovo.
  - Non deve: "Failed to fetch dynamically imported module"; errori MIME; plaintext in coda; setup offline.
  - Base: `vite.config.ts:59-63`; `argon2.ts:36`; `argon2Core.ts:1`; `vaultSession.ts:295-335`; `VaultUnlock.tsx:68-75`.

- [ ] **K.4 (ex SW-04) — sw.js con il predicato inline; precache con i chunk del bench e del Worker** (ALTA)
  - Passi:
    1. Apri http://localhost:4173/sw.js e cerca `/api/vault/`, `/api/notes/`, `api-cache`, `NetworkFirst`.
    2. In `workbox-precache-v2-*` cerca `VaultBenchPage-*.js` e `argon2.worker-*.js`.
  - Atteso:
    - `startsWith('/api')`, `!startsWith('/api/vault/')` e `!startsWith('/api/notes/')` sono inline, senza riferimenti esterni.
    - I chunk sono in precache (rischio §12.21 accettato).
  - Base: `vite.config.ts:64-79`; piano §12.21.

- [ ] **K.5 (ex SW-05) — Purge di api-cache una volta per versione** (MEDIA)
  - Passi:
    1. Imposta `api-cache-purged` a `0.0.0`.
    2. Ricarica.
    3. Ricarica di nuovo.
  - Atteso: cache cancellata al boot, chiave uguale alla versione di package.json, nessun purge al reload successivo.
  - Base: `main.tsx:12-18`.

---

## L. Concorrenza su DB dev (da annotare nell'addendum del piano §10)

- [ ] **L.1 (ex CONC-01) — 2 POST /api/vault/keyring paralleli: 201 + 409, una sola riga** (BLOCCANTE)
  - Prec.: C1 senza keyring, su /settings (non /vault). Backend `'*'`. Dopo il test l'account è inutilizzabile.
  - Passi:
    1. In Console, con la password vera:
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
  - Base: `vault.service.ts:221-293`; `routes/vault.ts:56-64,96-117`; piano `:631-635`.

- [ ] **L.2 (ex CONC-02) — /api/vault/migrate dello stesso item da 2 client in parallelo** (BLOCCANTE)
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
  - Base: `vault.service.ts:49-55,496-544`; `routes/vault.ts:34-46,135-138`.

---

## M. Telefono, mobile, dark mode, lingua

- [ ] **M.1 (ex LAN-01) — Verifica del contesto sicuro sul telefono** (ALTA)
  - Passi:
    1. Avvia Vite temporaneamente con `npm run dev -- --host` e apri `http://IP-LAN:5173` sul telefono.
    2. Dai DevTools remoti esegui la sonda di P0.6: `isSecureContext` deve essere false e `crypto.subtle` undefined.
    3. Se P0.1 dice "proxy", il login funziona: apri `/admin/vault-bench` col SUPERADMIN. Deve comparire il riquadro rosso `vaultBench.insecure` ("Serve un contesto sicuro (HTTPS con Web Crypto)...") con "Avvia" disabilitato. Se P0.1 dice "diretto", il login fallisce, perché il telefono chiama il proprio localhost:3001: limita la prova alla sonda.
    4. Ferma Vite `--host` e riavvialo normale. Con `adb reverse` (P0.6) la sonda dà tutto true e il bench non mostra il riquadro.
  - Non deve: dichiarare verificato un test vault fatto su http LAN.
  - Base: `VaultBenchPage.tsx:72,183-186`; `vaultNoteLock.ts:16`; `vite.config.ts:123-142`; `api.ts:5`; `app.ts:54`.
  - Limite: un tunnel pubblico espone il dev, e il superadmin ha una password nota. Chiudilo subito, oppure cambia prima la password.

- [ ] **M.2 (ex SK-26) — Setup e cerimonia del Kit su Android** (ALTA)
  - Passi:
    1. Setup: niente maiuscola automatica. "Crea Vault" raggiungibile con la tastiera aperta. Checkbox da 44 px.
    2. Il foglio del Kit sale dal basso, con la maniglia. Il Kit va a capo. Scroll oltre il 90%.
    3. Campi Gruppo: la tastiera non copre "Fine". Lettere maiuscole (`autoCapitalize characters`), niente autocorrezione.
    4. Barra dei gesti: safe area rispettata.
    5. Rotazione: stesso Kit e stessi gruppi.
    6. Background per 1 minuto: il Kit c'è ancora.
    7. PDF e Copia. Tema scuro.
  - Non deve: "Fine" coperto; Kit ricreato o perso.
  - Base: `RecoveryKitSheet.tsx:106-175`; `VaultSetup.tsx:138-191`; `frontend/CLAUDE.md`.

- [ ] **M.3 (ex VQ-26) — Uso quotidiano da telefono** (MEDIA)
  - Passi:
    1. Nota sicura: la toolbar resta sopra la tastiera. Indietro di sistema subito dopo aver scritto: il testo c'è.
    2. Header a 44 px che va a capo.
    3. Credenziale: genera, copia, incolla in un'altra app.
    4. Promemoria con `showPicker`.
    5. Modalità aereo e modifica, poi rete.
    6. Dark mode su VaultNotLoaded, banner e dialog.
  - Non deve: pulsanti coperti; perdita col back; testo inglese hard-coded.
  - Base: `VaultNoteEditor.tsx:245-338`; `VaultPage.tsx:655-663`.

- [ ] **M.4 (ex MIG-16) — Wizard di migrazione su Android: tempi PBKDF2, auto-lock, schermo spento, layout** (ALTA)
  - Prec.: Ricetta A più 10 credenziali v2. PIN precedenti: `K7rQ2X` (sbagliato, per primo), `oldPin1`, `passPhrase9`.
  - Passi:
    1. Avvia e cronometra dal Kit al riepilogo.
    2. 2-3 minuti senza toccare lo schermo.
    3. Variante: schermo spento per 1 minuto a metà.
    4. Layout: campi da 44 px, sheet del Kit con la tastiera, "Annulla" raggiungibile, tema scuro.
  - Atteso:
    - Barra fluida (Worker). Nessun auto-lock, perché `touchVault` viene chiamato in `onProgress`.
    - Gli item dopo il primo sono più veloci (`lastGood`).
    - Schermo spento: il giro riprende, oppure compare un errore con "Riprova", recuperabile come in B.8 e B.9.
  - Non deve: "Il vault si è bloccato" per inattività; UI congelata; item persi.
  - Base: `vaultMigration.ts:72-131`; `VaultMigrate.tsx:136-137`; `vaultStore.ts:4`; `legacyDecrypt.worker.ts`.

- [ ] **M.5 (ex MOB-01) — VaultSettingsSheet e VaultSettingsSection su telefono** (ALTA)
  - Passi:
    1. Il foglio sale dal basso, con la maniglia. Safe area su iPhone.
    2. Tastiera aperta sui 3 campi: il foglio scorre fino a "Cambia PIN".
    3. Orizzontale: al massimo 90vh, la X è raggiungibile.
    4. Tap sull'overlay: chiude, ma non durante un cambio PIN in corso.
    5. Aree di tocco di almeno 44 px.
    6. Sezione Vault di Impostazioni e ConfirmDialog.
    7. Screen reader: dialog "Impostazioni vault", focus intrappolato, switch annunciato con lo stato.
  - Non deve: scroll orizzontale; funzioni solo con hover; contenuti che richiedono lo zoom (`user-scalable=no`, `index.html:7`).
  - Base: `VaultSettingsSheet.tsx:22-25,76,174-195`; `VaultSettingsSection.tsx:14,92-103,113,122`.
  - Nota: la maniglia è decorativa, non c'è il drag per chiudere.

- [ ] **M.6 (ex UI-01) — Dark mode su tutte le schermate vault** (ALTA)
  - Prec.: tema scuro, poi "sistema". Su PC e telefono.
  - Passi: percorri tutte le schermate:
    - setup e Kit;
    - sblocco, PIN errato, lockout, riquadro "già creato", riquadro "PIN dimenticato?";
    - avviso offline, setupDisabled;
    - wizard di migrazione;
    - lista, banner, editor, credenziale, generatore, menu;
    - VaultSettingsSheet in tutti gli stati;
    - VaultSettingsSection (switch, removeBlocked, dialog, "Come funziona");
    - VaultUnlockDialog;
    - bench;
    - toast.
  - Atteso: testo leggibile su ambra, rosso e smeraldo. Input scuri. Pulsanti disabilitati riconoscibili.
  - Non deve: bianco su bianco; bordi invisibili; icone nere su fondo scuro.
  - Base: `VaultSettingsSheet.tsx:23-25,174-185`; `VaultSettingsSection.tsx:83-111`; `VaultPage.tsx:369-381,416-417`; `VaultUnlock.tsx:143-158`.
  - Nota: resetPending si raggiunge solo via SQL (A.8).

- [ ] **M.7 (ex UI-02) — Lingua IT ed EN: chiavi mancanti, plurali, testi lunghi** (ALTA)
  - Passi:
    1. Percorri tutte le schermate in IT e poi in EN, anche a 320-375 px di larghezza.
    2. Produci `removeBlocked`, `legacyLeft` e `later` con n=1.
    3. Messaggi d'errore: invalidPin, locked, offlineUnavailable, rateLimited, kitNotUpdated, setupDisabled, unavailable, pepperMismatch, notReady, networkError.
    4. Toast: "PIN cambiato", "Kit di recupero confermato", "Vault rimosso da questo dispositivo", pendingPinApplied e pendingPinNotApplied.
    5. Testi di sblocco e setup: `vault.lockedDescription`, `vault.setupDescription`, `vault.forgotPin`, `vault.unlock.forgotTitle/forgotBody`.
    6. Con lo SMTP: la lingua dell'email di lockout.
  - Atteso:
    - Nessuna chiave grezza, nessun testo nella lingua sbagliata, a capo corretto.
    - Annota le forme con n=1 ("1 elementi…", "1 vault changes…": `en.json:567,569,570,579`).
    - Annota che `rateLimited` ("Riprova tra poco") è impreciso per il limite orario della PUT.
  - Base: `en.json:540-592,1773-1809`; `it.json:427-447,523-524,552-553,641-687,1784-1808`; `VaultSettingsSection.tsx:111`; `VaultSettingsSheet.tsx:253,265,271`.

---

## N. Chiusura in dev e passi per la prod

- [ ] **N.1 (ex VER-01) — Controllo finale: nessuna NoteVersion non nv3 su note vault già cifrate** (BLOCCANTE)
  - Prec.: tutti gli utenti di prova sbloccati online almeno una volta dopo l'ultimo spostamento.
  - Passi:
    1. Q7.
    2. Q3 per ogni utente.
    3. Le righe con `plain_v` maggiore di 0 sono ammesse solo su note ancora legacy, e sulla RAW della variante F di B.16 (limite noto).
    4. Se una nota `nv3` ha ancora versioni in chiaro: sblocca online, attendi e rifai Q3.
  - Atteso: Q7 = 0, salvo le eccezioni del passo 3. Dopo lo sblocco ogni nota `nv3` con un documento valido ha `plain_v` = 0.
  - Base: `vault.service.ts:546-563`; `vaultMove.ts:252-260`; `vaultReconcile.ts:798-818`; design P2, accettazione 2.
  - E2E: in parte (`vault-migration`).

- [ ] **N.2 — Pulizia dev** — Lascia il backend su `'*'`, col pepper originale, per gli E2E. Fai Unregister del SW e Clear site data su :4173. Rimuovi il worktree `main`, se l'hai creato.

- [ ] **N.3 (nuova, REL-01) — PROD, passi 1-3 del runbook: test locali, SQL pre-deploy, .env chiuso** (BLOCCANTE)
  - Passi:
    1. In locale: per backend e frontend `test`, `tsc` (frontend: `npx tsc -p tsconfig.app.json --noEmit`), `lint` e `build`. Poi gli E2E completi più i 5 nuovi del vault, T6 verde, T25 con gli SPKI reali.
    2. Pre-deploy, in prod (le query le lanci tu):
       - `SELECT count(*) FROM "VaultKeyring";` → 0;
       - `SELECT "userId", count(*) FROM "Note" WHERE "isVault" AND content NOT LIKE 'nv3.%' GROUP BY 1;` → annota;
       - `SELECT n.id FROM "Note" n WHERE n."isVault" AND EXISTS (SELECT 1 FROM "Attachment" a WHERE a."noteId"=n.id);` → note vault con allegati (D3);
       - `SELECT "userId", count(*) FROM "Note" GROUP BY 1 HAVING count(*) > 50;` → utenti toccati da T0 (A.2);
       - `SELECT count(*) FROM "Note" WHERE "isVault" AND "noteType"='NOTE' AND content NOT LIKE '{%';` → limite di B.8 e B.16;
       - controllo dei lock su `"User"`.
    3. `.env` di prod: `VAULT_SETUP_USERS=` vuoto o assente.
    4. Al primo deploy annota il timestamp `ts1` di `_backup_<ts1>`. La regola è: il rollback pre-P2 si fa sempre da `_backup_<ts1>`, mai dal backup del secondo deploy.
  - Non deve: deploy con test rossi; `VAULT_SETUP_USERS` valorizzato prima del passo 8; rollback da un backup che contiene già un `dist` P2.
  - Base: piano `:677-684,689,718-722`.

- [ ] **N.4 (ex REL-02) — PROD, passi 4-5 del runbook: il bundle servito è davvero quello nuovo** (BLOCCANTE)
  - Prec.: deploy fatto con `VAULT_SETUP_USERS` vuoto. Annota `ts1`, lo SHA256 dello zip e il nome di `index-*.js`.
  - Passi:
    1. `curl.exe -s https://notiq.epartner.it/ | findstr index-`: deve coincidere con il pacchetto.
    2. `curl.exe -sI https://notiq.epartner.it/assets/NOME_INDEX.js | findstr /i content-type`: JavaScript, non text/html.
    3. Ctrl+F5: SW nuovo attivo, index nuovo caricato.
    4. `/sw.js`: stesso controllo di K.4.
    5. GET keyring: `no-store` anche attraverso IIS e ARR, `setupAllowed false` per tutti.
    6. `api-cache-purged` = versione nuova, cache svuotata.
  - Base: piano §11 passi 3-5; trappole di deploy in MEMORY; `main.tsx:12-18`; `routes/vault.ts:83-86`.

- [ ] **N.5 (ex REL-03) — PROD, passo 6: benchmark Argon2id su iPhone, Safari e PWA (manuale 1)** (BLOCCANTE)
  - Prec.: iPhone 12 o più recente (il più vecchio che hai), batteria carica, schermo sempre acceso, SUPERADMIN.
  - Passi:
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
  - Base: piano §10 manuale 1, §11 passi 6-7, §12.2 e §12.20; `VaultBenchPage.tsx:72-90,143-163,249`.

- [ ] **N.6 (ex REL-04) — PROD, passo 8: canary SUPERADMIN (punto di non ritorno)** (BLOCCANTE)
  - Prec.: `VAULT_SETUP_USERS=<ID_SUPERADMIN>` nel .env e `pm2 restart notiq-backend`.
  - Passi:
    1. Il bench mostra `t` ed `entry` uguali a quelli del pacchetto.
    2. Wizard di migrazione e Kit completo. Salva il PDF in un posto sicuro.
    3. Le query le lanci tu:
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
  - Base: piano §11 passo 8, rollback `:718-722`, §12.7; HANDOFF §4.4.

- [ ] **N.7 (ex REL-05) — PROD, passi 9-10: apertura a tutti e controlli successivi** (ALTA)
  - Passi:
    1. `VAULT_SETUP_USERS=*` e `pm2 restart notiq-backend`.
    2. Verifica `setupAllowed true`.
    3. Query legacy (passo 2 del runbook), programmata ogni settimana.
    4. `no-store` e cache su un secondo dispositivo.
    5. `/notiq-release`, con il tag solo sul pacchetto finale.
  - Non deve: apertura senza `pm2 restart`; tag su un pacchetto intermedio.
  - Base: piano §11 passi 9-11.

- [ ] **N.8 (ex S15 + SU-15 iOS) — Sospensione su iOS: lock trattenuti e auto-lock (PWA e Safari con due schede)** (MEDIA)
  - Passi:
    1. Safari: la scheda 1 è sbloccata con una nota aperta. Passa alla scheda 2, sblocca, "Controlla ora".
    2. Dal PC modifica la nota. Nella scheda 2 fai "Controlla ora". Chiudi la scheda 1 e ripeti.
    3. PWA: Home per 5 minuti, poi torna e scrivi.
    4. PWA: blocca il telefono col giro appena partito, poi "Controlla ora".
    5. PWA: assente più di 10 minuti. Al ritorno il vault deve essere già bloccato.
  - Atteso:
    - "verranno aggiornati più tardi" oppure attesa, mai errori.
    - Dopo la chiusura della scheda 1 il giro completa.
    - L'edit arriva senza copia.
  - Base: spec T15 §5; `vaultNoteLock.ts:46-66`; `vaultStore.ts:6-18`.

- [ ] **N.9 — iOS: Kit, setup e gestore password** — Sul telefono del canary rifai D.3 passo 7 (download del blob nella PWA standalone), D.4 variante C (swipe indietro), M.2, C.4 (portachiavi iCloud) e M.5.

---

## Riepilogo delle voci BLOCCANTE

| ID | Titolo breve | Sezione |
|---|---|---|
| A.1 | Utente senza keyring invariato, "Aggiungi al Vault" sicuro | A |
| A.2 | Pull completa con più di 50 note (T0) | A |
| A.3 | Kill switch chiuso: setupDisabled, 503, Riprova | A |
| A.4 | Canary: id esatti e trim | A |
| A.5 | Kill switch chiuso: gli utenti READY continuano | A |
| B.1 | Wizard completo, campi derivati NULL | B |
| B.2 | Nessun plaintext residuo dopo la migrazione | B |
| B.4 | Migrazione da 2 dispositivi (accettazione 14-15) | B |
| B.8 | Ripresa del finalize dopo un'interruzione | B |
| C.2 | Policy del PIN (accettazione 4) | C |
| D.4 | Cerimonia abbandonata, banner kitUnconfirmed | D |
| E.4 | Lockout al 6° errore | E |
| E.14 | Uscita con modifica non salvata (flush pre-lock) | E |
| E.16 | Logout con modifica non salvata | E |
| F.1 | Nota sicura mai in chiaro | F |
| F.14 | Trasforma in Kanban/Task list: plaintext al server | F |
| F.16 | Credenziale cifrata e metadati del sito | F |
| H.1 | Conflitto A offline / B online: una copia | H |
| H.2 | Conflitto con editor aperto (flake) | H |
| H.5 | Rete che cade a metà reconcile | H |
| I.1 | Ingresso nel vault: testo, cifratura, versioni | I |
| I.2 | Ingresso di una nota condivisa e pubblica in collaborazione | I |
| I.8 | Uscita dal vault e dispositivo B offline | I |
| J.1 | Cambio PIN: percorso felice | J |
| J.5 | Cambio PIN con un dispositivo offline (manuale 2) | J |
| J.7 | Rimozione dal dispositivo con la guardia | J |
| K.1 | api-cache senza vault e note (manuale 5) | K |
| K.2 | Logout e sblocco svuotano api-cache | K |
| L.1 | 2 POST keyring: 201 + 409 | L |
| L.2 | 2 migrate paralleli: CAS | L |
| N.1 | Nessuna versione in chiaro su note nv3 | N |
| N.3 | PROD: test locali, SQL pre-deploy, .env chiuso | N |
| N.4 | PROD: bundle e SW nuovi serviti | N |
| N.5 | PROD: benchmark iPhone, scelta di t | N |
| N.6 | PROD: canary SUPERADMIN | N |

## Non verificabile in dev, o solo in prod

- **iPhone e iOS in generale**: senza HTTPS e tunnel non c'è un contesto sicuro. Restano per la prod:
  - tempi di Argon2id e OOM (N.5);
  - PWA standalone;
  - download blob del PDF;
  - swipe indietro;
  - sospensione con lock trattenuti (N.8);
  - auto-lock dopo la sospensione;
  - portachiavi iCloud;
  - selettore di data e ora.
- **Tempi validi per D4 e D13**: solo con il bench in prod. In dev l'`entry` è vuota e i numeri non contano.
- **IIS e ARR**:
  - header `no-store` attraverso il proxy;
  - asset mancante che risponde 200 con `index.html`;
  - 502 con pm2 fermo (E.9, H.6). In dev il backend fermo dà status 0 (diretto) o 500 (proxy di Vite), mai un 5xx dal backend;
  - timeout che producono risposte perse (H.4 e I.7 sono solo simulati).
- **Passaggio reale 1.13.3 → P2 con PWA autoUpdate**: bundle vecchio in cache, `vault-storage` riscritto da una scheda vecchia (H.15 è simulato), purge `api-cache-purged` al primo avvio (K.5 è simulato).
- **Kill switch letto dal .env con `pm2 restart`**: in dev si usa la variabile di processo.
- **Rate limit per processo pm2 e chiave del limiter dietro ARR** (H.12).
- **Email di lockout reale**: in dev serve lo SMTP configurato, altrimenti c'è solo un warn nel log.
- **Gare al millisecondo**:
  - due POST keyring nello stesso ms (coperto dagli unit test del backend);
  - "201 o 200 perso" sullo stesso dispositivo (si verifica solo lo stato finale equivalente: D.4 variante E, C.6);
  - ramo `pinApplied` (J.3 passo 6 è solo un tentativo; la copertura certa è degli unit test).
- **Fallimento di IndexedDB** (toast `vault.setup.offlineNotSaved`) e item `failed` `vault:*` creati a mano: coperti solo dagli unit test.
- **Chiavi non raggiungibili dalla UI, da non cercare**:
  - `vault.itemEmptyOnServer`: la prop `emptyOnServer` non viene mai passata;
  - `vault.credential.shape`: è il messaggio di un Error interno e a schermo diventa `decryptFailed`;
  - `vault.migrate.errors.invalid/aborted/notReady`: solo per errori interni del giro;
  - legacy senza uso: `vault.pinTooShort`, `vault.resetVault*`, `vault.decryptError`, `vault.incorrectPin`, `vault.empty`, `vault.warningDescription/warningConfirm`, `vault.credential.saved/fetchingMetadata`. Queste vengono dal grep del critico: ho verificato solo `credential.shape` e `itemEmptyOnServer`.
- **Caratteri fuori Latin-1 nel PDF**: non osservabili con le lingue attuali.
- **Stato RESET_PENDING reale e recupero col Kit**: arrivano con P3 e P4. In dev lo stato si forza via SQL.
- **Root key**: anche in dev è quella di prod (`rk_68a265761e7e37c7`). I keyring creati in dev restano solo nel DB dev.

## Correzioni del critico scartate

| Punto del critico | Motivo dello scarto |
|---|---|
| 26, `vault.migrate.notVerified` fra le chiavi morte | È usata a schermo (`VaultMigrate.tsx:341`) quando ci sono item in conflitto, non verificati o falliti. |
| 26, `vault.settings.skipped.*` fra le chiavi non verificabili | È renderizzata (`VaultSettingsSheet.tsx:247`), e `skipped.busy` si produce a mano (J.9). |
| 26, `vault.settings.reason.tooLarge` fra le chiavi morte | Fa parte dell'elenco fisso delle 4 cause, mostrato sempre con `unresolved` (`VaultSettingsSheet.tsx:274-275`). |
| 18, "prima del wizard l'apertura mostra legacyUnreadable" | Con keyring NONE e legacy, /vault mostra solo il wizard. Il wizard poi cifra la NOTE byte per byte e la finalizza dopo un confronto esatto (`vaultMigration.ts:58,288-314`). Il banner compare solo su una NOTE non JSON rimasta legacy, per esempio troppo grande: B.16 è costruita così. |
| 15, "con `m` = 1024 compare sicuramente Qualcosa è andato storto" | Non l'ho verificato su `deriveS`. Ho tenuto lo scenario (G.4), con l'esito marcato "da osservare". |

---

Note:
- Ho verificato sul codice queste correzioni del critico:
  - A.6 e E.9: `isUnreachable` accetta 0 e 503 (`VaultUnlock.tsx:17-20`); `preHandler` 503 (`routes/vault.ts:88-90`); `api.ts:5`;
  - J.3: testo `it.json:524`;
  - B.5 e D.7: off by one del lockout (`vault.service.ts:396-424`, `vaultSession.ts:117-118`); PIN non svuotato (`VaultMigrate.tsx:236-239`); "Annulla" con `onDone`;
  - E.7: dialog solo per note pubbliche o condivise (`NoteEditor.tsx:787,845`);
  - A.8: `vaultEntryState` (`vaultMove.ts:131-137`) e `moveOut.notReady` (`note.service.ts:290`, `it.json:594`);
  - B.7: guardia `busy` (`RecoveryKitSheet.tsx:90-91,172`);
  - C.7: 409 con `clearPending('kit')` (`vaultSession.ts:454-461`);
  - A.2: `all=1` (`syncService.ts:119`);
  - E.2: `forgotPin` (`VaultUnlock.tsx:142-159`);
  - A.7: `pepperMismatch` (`vault.service.ts:385`);
  - F.5: `gone` (`VaultNoteEditor.tsx:128,237`);
  - pendingPinApplied (`vaultSession.ts:491-495`);
  - H.14: `removeItem` (`vaultStore.ts:187-193`);
  - C.5: audit (`vault.service.ts:234`);
  - P0.2: rate limit (`routes/vault.ts:92,140`);
  - N.3: piano `:677-689`.
- Non ho potuto leggere `frontend/.env` (lettura negata): l'host delle chiamate `/api` va osservato con P0.1. Per lo stesso motivo il 500 del proxy di Vite con il backend fermo è un'attesa da confermare.
- Non ho riverificato le righe citate per `Editor.tsx` (paste, drop, trasformazioni), la pull-flip di `syncService`, `useSync`, `kitPdf.ts`, `email.service` EN ed `en.json`. Vengono dalla checklist d'origine.
- PIN2 `m4Tz8q` non è stato provato contro la policy.