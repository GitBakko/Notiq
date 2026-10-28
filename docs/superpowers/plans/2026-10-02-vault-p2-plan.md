# Piano P2 (vault v3): client E2EE, migrazione, multi-dispositivo (un solo rilascio)

Questo piano l'ho scritto in sola lettura: non ho modificato nessun file. I riferimenti `file:line` li ho verificati su `main` `3dec737` (1.13.3, in prod). È la revisione 2: recepisce la review di `reviewer` e `red-team` (Appendice B, "Tracciabilità review"). I finding respinti, anche solo in parte, stanno nell'Appendice A.

Revisione 3 (02/10): applicati i gap G1-G8 della verifica finale di completezza (G1 MAJOR: predicato Workbox inline).

Revisione 4 (21/10): decisioni D1-D13 dell'utente ed emendamento D13/D4 (benchmark in prod), con review e red-team; vedi Appendice C.

Abbreviazioni:
- design = `docs/superpowers/plans/2026-09-30-vault-v3-design.md`, citato come "design:N";
- piano P1 = `docs/superpowers/plans/2026-09-30-vault-p1-plan.md`, citato come "P1:N";
- HANDOFF = `docs/superpowers/plans/2026-10-01-HANDOFF.md`, citato come "HANDOFF:N";
- "accettazione N" = N-esimo punto dei criteri di accettazione P2 in design:525-540, contati in ordine:
  1. DB: solo `nv3.` (più credenziali legacy bloccate) e `title=''`;
  2. dopo `finalize`: nessuna versione non-envelope, `searchText`/`ydocState` NULL;
  3. dispositivo B chiede il PIN e decifra;
  4. policy del PIN (rifiutati/accettato, case-sensitive);
  5. Kit solo dopo il 201, una volta, 2 gruppi da riscrivere, controllo di battitura;
  6. rigenerazione del Kit solo da sbloccato, escrow nuovo;
  7. sblocco offline OFF: niente `wrappedVkPin`/share, avviso offline;
  8. logout → login porta allo sblocco, non al setup;
  9. offline: sblocco con cache, avviso senza, mai il setup;
  10. `kdfParams` manomessi → sblocco fallito (al setup i parametri vengono da `DEFAULT_KDF`; allo sblocco arrivano dal server e li proteggono il controllo client di §3, riga "Controllo `kdfParams`", più `kdfCanon` nell'AAD);
  11. 3 edit offline con riferimento in coda → 0 conflitti falsi;
  12. edit concorrente reale → 1 copia, nessuna perdita;
  13. utente legacy seed migrato con valori identici;
  14. item con PIN sconosciuto byte-identico;
  15. migrazione da 2 dispositivi: 1 keyring, nessuna perdita;
  16. bundle vecchio che scrive plaintext dopo il keyring → 1 copia in conflitto.

Gli addendum P1 prevalgono sul design (design:394). Dove questo piano prevale sul design, lo dice la tabella delle deviazioni in §1.

---

## 1. Obiettivo e perimetro

**Obiettivo (design:517-545).** Un rilascio che porta:
- `vaultCrypto` con Argon2id in un Worker;
- la macchina a stati UNKNOWN / NONE / READY / UNLOCKED;
- setup con il Kit mostrato dopo il 201;
- sblocco online e offline;
- policy del PIN;
- cerimonia del Kit e sua rigenerazione;
- interruttore "sblocco offline" per dispositivo;
- logout che blocca il vault invece di azzerarlo;
- envelope per note, credenziali e titoli;
- idratazione;
- push latest-state e copie in conflitto;
- wizard di migrazione + `finalize`;
- spostamento dentro e fuori dal vault;
- cambio PIN.

**Invarianti da dimostrare con i test:**
- **Nessun dato vault viene cancellato** finché il client non ha riletto i byte dal server e non li ha verificati (design:307-312). L'unica cancellazione è `POST /vault/finalize` sulle versioni in chiaro.
- **Utenti senza keyring e note normali: comportamento invariato, lato server e lato push.**
  - Server: `getVaultGuard` resta `null` per loro (`vault.service.ts:59-68`). Tutte le modifiche server alle note sono condizionate a `guard` non nullo:
    - `flushLiveDoc` all'ingresso nel vault (solo con `guard`);
    - CAS nel restore vault;
    - guardia "envelope su nota non vault" (che rifiuta solo envelope `nv3.`, che senza keyring non esistono).
  - Uniche eccezioni non condizionate, dichiarate:
    - il fix `searchText` delle CREDENTIAL in uscita senza keyring;
    - `bodyLimit` di 3 MiB (oggi 1 MiB implicito: nessuna richiesta valida oggi viene rifiutata);
    - `GET /notes?all=1` (T0, parametro opt-in).
  - Push: senza keyring READY in cache per l'utente corrente, `syncService` invia i payload in coda **invariati**, come oggi (§5.7.0).
- **Il plaintext del vault, dopo lo sblocco, non tocca mai IndexedDB, localStorage, la syncQueue né la Cache Storage del SW.**
  - In Dexie e in coda vanno solo envelope.
  - I titoli decifrati stanno solo in memoria.
  - Le risposte `/api/vault/*` e `GET /api/notes/:id` non entrano in `api-cache` (T12).
- **Nessuna versione Dexie nuova.** `vaultBaseHash` è un campo non indicizzato: cambia solo il tipo `LocalNote` (design:256, :462).
- **`crypto.ts` non si tocca.** Serve solo in lettura alla migrazione (design:73).
- **Nessuna migration Prisma** (§2).

**Fuori perimetro:**
- **P3** (design:547-555): reset, `RESET_PENDING` reale, job di hard delete, epoch+1, purge dei dispositivi. Comprende anche il job "utenti `IN_PROGRESS` da più di 7 giorni" (design:316).
- **P4** (design:557-578): recupero root, `vaultRecovery.service`, `vaultAdmin.ts`, `vaultRootKey.service`, `VaultRecovery.tsx`, `RecoveryCodeForm.tsx`, notifiche `VAULT_RECOVERY`, banner `openRecovery`.
- **P5** (design:580-583): viewer delle versioni che decifra, rotazione della chiave root (con re-seal tramite `userShareUnderVk`), manifest firmato.
- **Rotazione di VK (design:253): fuori da P2**, D1. `rotate` resta 400 `rotateNotSupported` (`vault.service.ts:315`).
- **CSP della SPA:** in backlog (§12.13).
- **"bulkPut del sync solo per le note cambiate" (HANDOFF §3.2): rimandato** (§12.15). T0 tocca lo stesso blocco e non va appesantito con un'ottimizzazione.

**Deviazioni dal design, motivate:**

| Design | P2 | Motivo |
|---|---|---|
| `features/vault/vaultApi.ts` (design:438) | `lib/vaultApi.ts` + `lib/vaultSession.ts`; UI condivisa in `components/vault/` | La usano `features/notes`, `features/settings` e `features/vault`. CLAUDE.md vieta gli import tra feature dir |
| Prop `vaultCodec` in `NoteEditor` (design:451) | Nuovo `features/vault/VaultNoteEditor.tsx`, con i controlli di oggi portati sopra (T18) | `NoteEditor.tsx` ha 905 righe con collab, guard pre-sync 1.13.3, allegati, AI e versioni. Senza `noteId`/`provider` l'editor dedicato esclude per costruzione condivisione, AI, versioni, allegati e paste/drop (`Editor.tsx:244-249`, `ImageDrop.ts:48`, `:78`) |
| Guardia TIER 2 in `Editor.tsx` (design:467) | `Editor.tsx` non si tocca | Senza `noteId`, `uploadFn` è `undefined` (`Editor.tsx:244`) e `ImageDrop` lascia passare l'evento. Il server blocca comunque (`attachments.ts:40-42`) |
| `pinHash` locale come trigger e verifica (design:292, :298) | Trigger = `legacyCount>0`. I vecchi PIN si verificano decifrando le credenziali. `pinHash` azzerato al logout e al primo READY | `logout()` lo cancella già (`authStore.ts:76`). È uno SHA-256 non salato: è un leak |
| Il passo 0 della migrazione si blocca sui `failed` (design:294) | Si blocca solo sui **pending**. I `failed` li assorbe il reconcile dopo il keyring (§5.8.3) | Un item avvelenato bloccherebbe la migrazione per sempre |
| Solo la push in `syncService` (design:460) | Push **e** pull: la pull preserva `vaultBaseHash` | `bulkPut` riscrive la riga intera (`syncService.ts:127-135`, `:191`). Senza preservarlo, ogni pull genererebbe una copia in conflitto falsa |
| `c: <TipTap JSON \| CredentialData>` (design:68) | `c` è una **stringa** | Il round-trip diventa un confronto esatto di stringhe (design:537) |
| `GET /keyring` invariato | + `escrowHash = hex(sha256(escrowBlob grezzo))` (T1) | Retry idempotente della rigenerazione del Kit con un 200 perso (design:162) |
| `POST /items` invariato | + `title` e `hasPlaintextVersions` (T1) | `title`: sorgente dei titoli della migrazione (`GET /notes` è paginato a 50, `routes/notes.ts:46`). `hasPlaintextVersions`: riprendere `finalize` senza stato sul client (P1:640) |
| — | Kill switch `VAULT_SETUP_USERS` (T1) | Canary (D2) |
| — | `GET /notes?all=1` + pull non paginata (T0) | La pull chiede `/notes?includeTrashed=true` (`syncService.ts:118`), che restituisce 50 righe (`routes/notes.ts:46`, `note.service.ts:121-122`), poi cancella le righe `synced` locali assenti (`:157-172`). L'idratazione vault e la preservazione di `vaultBaseHash` richiedono le righe |
| Esclusione di `vite.config.ts` | `vite.config.ts` si tocca (T12) | La cache Workbox `NetworkFirst` su tutto `/api` (`vite.config.ts:64-76`) salverebbe la risposta keyring e i `GET /notes/:id` in chiaro |
| Kit e cambio PIN in Impostazioni (design:123) | Dentro `VaultPage` (sheet "Impostazioni vault"). In `SettingsPage` restano switch offline, rimozione e spiegazione | `VaultPage` blocca il vault all'unmount (`VaultPage.tsx:179-184`): in Impostazioni il vault è sempre bloccato. Il lock all'unmount resta (sicurezza) |
| Job admin, script `legacyCount`, banner di sollecito (design:316, :336) | Job → P3; script → SQL nel runbook; banner → solo in `VaultPage` | In prod `legacyCount` è 2 per un solo account |
| Spostamento nel vault via syncQueue (`NoteEditor.tsx:347-374`) | **Solo online**, con chiamata API diretta; `noteService` rifiuta ogni cambio di `isVault` (T21a) | La CAS e `finalize` sono online per definizione (D7) |

---

## 2. Schema e migration

**Nessuna migration.**
- `escrowHash`, `hasPlaintextVersions` e `title` in `/items` sono calcolati o letti al volo.
- Il kill switch è una variabile d'ambiente.
- `vaultBaseHash` vive solo in Dexie.
- `?all=1` è un parametro di query.

`npx prisma migrate deploy` deve dire **"No pending migrations"**.

---

## 3. Specifica crittografica (vincolante, completa design:35-73)

Convenzioni:
- stringhe in UTF-8; separatore `|`; `epoch` in decimale;
- HKDF = HKDF-SHA256 di WebCrypto; salt ∅ = `new Uint8Array(0)`;
- AES-GCM-256 con IV casuale di 12 B; formato binario `iv ‖ ct ‖ tag`;
- byte in base64url senza padding.

**Hash (vincolante, uguale su BE e FE):**
- `contentHash`/`baseHash`/`vaultBaseHash` = `hex(sha256(utf8(string)))`. Lato server è `sha256hex` (`vault.service.ts:45-46`).
- `escrowHash` = `hex(sha256(60 byte grezzi di escrowBlob))`:
  - BE: `createHash('sha256').update(Buffer.from(row.escrowBlob)).digest('hex')`, **non** `sha256hex`;
  - FE: `crypto.subtle.digest('SHA-256', escrowBytes)` → hex minuscolo;
  - vettore incrociato fisso in T1 e T13.

| Elemento | Definizione | Byte |
|---|---|---|
| PIN | `pin.normalize('NFC')` prima di Argon2id (`vaultRootKeyFile.ts:52-56`, HANDOFF:89) | 6 caratteri |
| `S` | Argon2id(PIN, `pinSalt` 16 B, `kdfParams`, `hashLength` 32), in un Worker (`hash-wasm`) | 32 |
| Controllo `kdfParams` (client) | Rifiuta `m<65536`, `m>1048576`, `t<3`, `t>10`, `p≠1` **prima** di derivare. Il controllo vive nel wrapper, non nella funzione raw del Worker | — |
| `kdfCanon` | `` `{"m":${m},"t":${t},"p":${p}}` `` costruita dai numeri, mai dal JSON del server | — |
| `authKey` | HKDF(S, salt ∅, info `notiq/vault/v3/auth\|`+userId) | 32 |
| `serverShare` | Casuale, generato dal client al setup; lo restituisce `POST /unlock` | 32 |
| `KEK_pin` | HKDF(S‖serverShare, salt=`pinSalt`, info `notiq/vault/v3/kek\|`+userId) → AES-GCM | — |
| VK | 32 B casuali. In memoria come due CryptoKey non-extractable (HKDF per `K_note`, AES-GCM per i wrap). I byte grezzi esistono solo dentro setup, sblocco, rigenerazione e cambio PIN, poi `fill(0)` | 32 |
| `wrappedVkPin` | AES-GCM(KEK_pin, VK, AAD `vk\|`+userId+`\|`+epoch+`\|`+kdfCanon) | 60 |
| `vkSigKey` | ECDSA P-256 extractable solo per esportare PKCS#8 e SPKI, poi reimportata non-extractable | — |
| `vkSigPub` | SPKI | 91 |
| `wrappedVkSigKey` | AES-GCM(VK, PKCS#8, AAD `vksig\|`+userId+`\|`+epoch) | circa 166 (range 80-220) |
| `vkProof` | Firma di `notiq/vault/v3/proof\|PUT /api/vault/keyring\|`+userId+`\|`+epoch+`\|`+rev+`\|`+sha256hex(payloadRaw) (P1:407-408, `vault.service.ts:93`), r‖s | 64 |
| `K_note` | HKDF(VK, salt=utf8(noteId), info `notiq/vault/v3/note`) → AES-GCM, in cache per noteId finché il vault è sbloccato | — |
| Envelope | `nv3.<epoch>.<b64u iv>.<b64u ct‖tag>`. Plaintext `JSON.stringify({v:1,t:string,c:string})`. AAD `notiq/vault/v3/item\|`+userId+`\|`+noteId+`\|`+noteType+`\|`+epoch. Un epoch diverso da quello del keyring dà `stale`. Deve passare `vault.service.ts:49` | — |
| `S_root` | Casuale | 32 |
| `sealedRootShare` | `ephPubRaw`(97) ‖ iv ‖ AES-GCM(Kseal, S_root, AAD `notiq/vault/v3/rootshare\|`+userId+`\|`+epoch+`\|`+rootKeyId) ‖ tag. Kseal = HKDF(ECDH(eph, rootEcdhPub) 48 B, salt=`ephPubRaw`, info `notiq/vault/v3/rootseal\|`+userId+`\|`+rootKeyId) | 157 |
| `S_user` (Kit) | Casuale | 20 |
| RK | HKDF(S_root‖S_user, salt ∅, info `notiq/vault/v3/escrow\|`+userId) → AES-GCM | — |
| `escrowBlob` | AES-GCM(RK, VK, AAD `escrow\|`+userId+`\|`+epoch+`\|`+rootKeyId) | 60 |
| `userShareUnderVk` | AES-GCM(VK, S_user, AAD `usershare\|`+userId+`\|`+epoch). Solo per il re-seal in P5: **il Kit non si ri-mostra** (design:50) | 48 |
| Chiave del dispositivo | AES-GCM-256 non-extractable per userId, in IndexedDB raw `notiq-vault-device`. `shareEnc` = AES-GCM(devKey, serverShare, AAD `notiq/vault/v3/device\|`+userId+`\|`+epoch) | — |

**Kit (design:122, :529).**
- Alfabeto Crockford `0123456789ABCDEFGHJKMNPQRSTVWXYZ`: 20 B → 32 simboli (5 bit big-endian).
- Controllo: `c = Σ_{i=0..31}(i+1)·v_i mod 1021`, in 2 simboli (`⌊c/32⌋`, `c mod 32`).
  - Sostituzione singola sempre rilevata: `|(i+1)·δ| ≤ 992 < 1021`.
  - Scambio adiacente sempre rilevato: la differenza è `v_i−v_{i+1}`, diversa da 0, con modulo al massimo 31.
- Visualizzazione: `XXXX-…-XXXX  CC`.
- Parsing: maiuscolo, via `-` e spazi, `O`→`0`, `I`/`L`→`1`, `U` o altro → errore.

**Argon2id.**
- `hash-wasm ^4.12.0`, come il backend (`backend/package.json:62`), con il WASM in base64 nel chunk.
- Worker con `new Worker(new URL('./argon2.worker.ts', import.meta.url), {type:'module'})`. Il chunk `.js` è precachato da `globPatterns` (`vite.config.ts:62`).
- `DEFAULT_KDF = {m:65536, t:3, p:1}` è una costante unica esportata da `utils/argon2.ts` (T5).
  - La usano solo i keyring NUOVI (setup e kdfParams del nuovo wrap nel cambio PIN, T13). Lo sblocco usa sempre i `kdfParams` del keyring.
  - `t` si fissa dopo la misura in prod (D4, runbook §11, passo 6). Se cambia, si cambiano nello stesso commit `DEFAULT_KDF.t` e il valore di `KDF_T_MIN` (vedi sotto), prima del canary. I test usano la costante, non il letterale.
  - **Pavimento server (F2, G1).** Il pavimento di `t` vive in DUE schemi backend: `backend/src/routes/vault.ts:16` (POST setup) e `backend/src/services/vault.service.ts:281` (`keyringUpdatePayloadSchema`, cambio PIN via `updateKeyring`), oggi entrambi `min(3).max(10)`.
    - Nel task server di P2 che tocca `vault.service.ts` (T1) si introduce `export const KDF_T_MIN = 3` in `vault.service.ts`, usata da ENTRAMBI gli schemi (`min(KDF_T_MIN)`); `routes/vault.ts` la importa.
    - Se la misura dà t>3, nello STESSO commit di `DEFAULT_KDF.t` si cambia SOLO il valore di `KDF_T_MIN` (al t scelto). Nessun altro file di produzione.
    - I test che oggi scrivono `t: 3` a mano (`vault.keyring.test.ts:38` e `:259`, `vault.service.test.ts:286`) usano la costante.
  - Effetto: un bundle vecchio in cache che tenta setup o cambio PIN con t=3 (sotto il pavimento nuovo) riceve 400: setup o cambio PIN non avvengono, il client mostra `errors.vault.invalidPayload` (oggi assente da `frontend/src/locales/en.json` e `it.json`: si aggiunge in T24, coperta da `i18nVaultKeys.test.ts`); per proseguire serve un hard reload. Il valore di `KDF_T_MIN` cambia solo nel ramo t>3.

**Policy del PIN (`PinPolicy.ts`, design:71).**
- Regex `^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9]{6}$`.
- Poi, sul minuscolo:
  1. `19\d\d`, `20\d\d`, `ddmm`, `mmyy`;
  2. sequenze e camminate di tastiera di 3 o più caratteri, anche al contrario;
  3. ripetizioni di 3 o più caratteri, schemi alternati (`a1a1a1`, `a1b2c3`);
  4. prefisso di 4 o più lettere presente nella blocklist IT/EN (2-5k voci, `import()` lazy), più cifre;
  5. sottostringa di 4 o più caratteri di nome, cognome o local-part dell'email.

---

## 4. Server (T0-T4; non TIER)

### 4.0 `routes/notes.ts` + `note.service.ts`: lista completa per la pull (T0)
- `getNotesQuerySchema` (`routes/notes.ts:39-47`) aggiunge `all: z.literal('1').optional()`.
- Con `all`, `getNotes` (`note.service.ts:99-122`) non applica `skip`/`take`.
- La select della lista resta quella di oggi, senza `content`: il peso è quello di prima di 73ae89a.
- Senza `all` il comportamento è invariato: UI paginata, ricerca.

### 4.1 `vault.service.ts` (T1)
- **`getKeyring`** (`:156-181`): `escrowBlob` nella `select`, poi `escrowHash` (formato in §3), `null` senza riga o senza blob. `escrowBlob` non compare **mai** nella risposta (test).
- **`itemSelect`** (`:423`): aggiungere `title: true`. Per gli envelope è `''`; per gli item legacy è il titolo in chiaro, che serve alla migrazione.
- **`hasPlaintextVersions`:** `_count: { select: { versions: { where: { NOT: { content: { startsWith: 'nv3.' } } } } } }` (relazione `versions`, `schema.prisma:160`), poi `count > 0`.
- **Kill switch in `createKeyring`**, dopo il controllo di `:207`:
  - `const allow = process.env.VAULT_SETUP_USERS ?? ''`;
  - se `allow !== '*'` e userId non è nella lista separata da virgole (trim) → 503 `errors.vault.setupDisabled`;
  - variabile assente → 503;
  - letto a ogni chiamata (`:12-19`).
- Nessun'altra route. `rotate` resta 400 (D1).

### 4.2 `note.service.ts` + `routes/notes.ts` (T2)
- **Ingresso nel vault con doc live** (P0 limite 3, design:497), **solo con `guard`:**
  - in `updateNote`, subito dopo `:226` (il guard è calcolato), se `guard && rest.isVault === true && !note.isVault` e il doc è live (`hocuspocus.hocuspocus.documents.has(id) || loadingDocuments.has(id)`, come a `:295`):
    - `try { await flushLiveDoc(id) } catch (e) { logger.warn(...) }`, poi si **rilegge** `note` (`const` → `let` a `:219`);
    - `hocuspocus` è già importato in modo statico (`note.service.ts:2`): nessun import lazy;
    - con il flush fallito si prosegue: la CAS protegge comunque.
  - Fra il flush e la `$transaction` restano degli await (`:229-256` notebook/tag, `:265` allegati). **A chiudere la finestra è la CAS** di `:394` (`where: { id, content: note.content }` con il `note` riletto): va mantenuta così. Un edit salvato dopo la rilettura dà 422 `conflict` e il client ritenta (§5.9).
  - Senza `guard` (utente senza keyring) il flush non avviene: comportamento invariato.
- **`searchText` delle CREDENTIAL legacy:** a `:368` aggiungere `&& note.noteType === 'NOTE'`.
- **`routes/notes.ts`:**
  - `bodyLimit: 3 * 1024 * 1024` su `POST /` (`:52-56`) e `PUT /:id`;
  - `content: z.string().max(2 * 1024 * 1024)` in `createNoteSchema` e `updateNoteSchema`, allineato a `routes/vault.ts:40`;
  - oggi il limite implicito è 1 MiB (`app.ts:44-49`).

### 4.3 `noteVersion.service.ts` (T3)
- **CAS sul restore vault:** in `restoreNoteVersion`, `updateMany` (`:323-325`) con `note.isVault` → aggiungere `content: note.content` al `where`. `count 0` → 409 `restoreConflict`.
- **Envelope su nota non vault** (P1:655):
  - dopo `:275`, `if (!note.isVault && parseEnvelope(version.content)) throw new AppError(422, 'errors.vault.plaintextRequired')`;
  - stesso controllo in `getVersionForRestoreCheck` (`:247-258`).

### 4.4 `backend/src/utils/vaultSeal.ts` (nuovo, T4)
- `sealRootShare` e `openRootShare` come in §3, con `node:crypto`. Li useranno P4 e i test.
- Vettori incrociati con il frontend (T7).

---

## 5. Client: architettura

### 5.0 "v3 attivo": quando valgono le regole nuove
`isV3Active(uid) = vaultStore.byUser[uid]?.status === 'READY' && Number.isInteger(byUser[uid].epoch)`.
- Tutte le regole di push e retry su note vault di §5.7 valgono **solo** se `isV3Active(authStore.user.id)`.
- Altrimenti la coda si comporta come oggi, payload invariati, titoli compresi.
- Se il server è già READY (setup da un altro dispositivo) ma la cache locale non lo sa, gli item legacy prendono 422 `plaintextRejected` → `vault:plaintextRejected` (§5.7.6) e li assorbe il reconcile (§5.8.3).

### 5.1 Moduli
- **`utils/argon2.worker.ts` + `utils/argon2.ts`:**
  - `argon2Raw(pin, salt, params)` senza controlli, usata dai test KAT;
  - `deriveS(pin, salt, params)` con NFC + controllo di `kdfParams`;
  - un solo Worker, timeout 30 s, errore `kdfFailed`; fallback diretto solo se `typeof Worker === 'undefined'`;
  - dopo un rifiuto o un timeout: `worker.terminate()` e ricreazione lazy alla chiamata seguente (un Worker bloccato o morto per OOM non avvelena le derivazioni successive); `resetArgon2Worker()` e il terminate dopo rifiuto/timeout rifiutano subito con `kdfFailed` le richieste pendenti di quel Worker; il timer di timeout cattura la propria istanza di Worker e non termina mai un'istanza diversa;
  - esporta `resetArgon2Worker()` (G2): `terminate()` del Worker corrente e riferimento a `null`; il Worker si ricrea in modo lazy alla chiamata seguente di `deriveS`. Lo usa il bench (T6) per i campioni a freddo;
  - esporta `DEFAULT_KDF` (§3).
- **`utils/vaultCrypto.ts`:** tutto §3 tranne il Kit. Funzioni pure.
- **`utils/vaultKit.ts`:** Kit.
- **`utils/vaultRootKeys.ts`:** chiavi pubbliche fissate (T25).
- **`lib/vaultApi.ts`:** client delle 7 route, errori `{status, key}`, **mai** 401 atteso (P1:245).
- **`lib/vaultSession.ts`:**
  - flussi `setup`, `unlockOnline`, `unlockOffline`, `changePin`, `regenerateKit`, `setOfflineUnlock`, `removeFromDevice`;
  - `purgeApiCache()` = `caches?.delete('api-cache')`.
- **`features/vault/deviceKeyStore.ts`:** IndexedDB raw `notiq-vault-device` con 3 store:
  - `deviceKeys` (userId → CryptoKey);
  - `shares` (userId → `{epoch, shareEnc}`);
  - `pending` (userId → `{kind:'kit', escrowHash, confirmed:false}` | `{kind:'pin', rev, wrappedVkPinHash}`). **Nessun segreto:** niente `authKey`, payload o PIN.
- **`features/vault/vaultCodec.ts`:**
  - `encryptItem`/`decryptItem`;
  - cache `Map<envelope,{t,c}>` FIFO di 500, svuotata a lock, logout e cambio utente;
  - registro `openVaultNoteIds: Set<string>` (§5.8.1).
- **`features/vault/vaultReconcile.ts`**, **`vaultMigration.ts`**, **`lib/vaultMove.ts`**.

### 5.2 `vaultStore.ts` (TIER 1)
- **Persistito** (chiave `vault-storage` invariata, `partialize` additivo a `:65`):
  - `isSetup`, `pinHash` (legacy);
  - `byUser: Record<userId, {status, epoch, rev, kdf, kdfParams, pinSalt, wrappedVkPin?, rootKeyId, offlineUnlock}>`.
- **In memoria:** `isUnlocked`, `unlockedUserId`, `keys: {vkHkdf, vkAes, sigKey} | null`, `epoch`.
- **Azioni nuove:**
  - `setKeyringCache`, `unlock(userId, keys, epoch)`, `clearLegacy()`, `setOfflineUnlock`, `forgetUser`, `touchVault`;
  - `registerPreLock(fn: (keys) => Promise<void>): unregister`;
  - `lockVault()`: cattura `keys`, li azzera nello store, poi chiama ogni flusher registrato con le chiavi catturate. Le CryptoKey restano valide finché il riferimento esiste, così l'ultimo salvataggio dell'editor si cifra e non si perde. Infine svuota la cache di `K_note`.
- **Campi legacy** (`pin`, `setupVault`, `unlockVault`, `resetVault`):
  - **restano in T11 come `@deprecated`**, così `tsc` resta verde: li usano `VaultPage.tsx:36`, `CredentialCard.tsx:17`, `CredentialForm.tsx:32`, `VaultSetup.tsx:11`, `VaultUnlock.tsx:11`/`:30`, `credentialTypes.ts:28-36`, `authStore.ts:76`;
  - li rimuove **T24b**, dopo T12/T16/T17/T19.
- **Auto-lock** a 10 minuti invariato (`:4-18`). Ogni modifica nell'editor vault chiama `touchVault`.
- **Regola:** le chiavi valgono solo se `unlockedUserId === authStore.user.id`, altrimenti `lockVault()`.

### 5.3 Macchina a stati (sostituisce `VaultPage.tsx:197-203`)

| Stato | Condizione | UI |
|---|---|---|
| UNKNOWN | `GET /keyring` fallisce (rete, 5xx, 404) e non c'è `byUser[userId]` | `VaultOfflineNotice`. **Mai** il setup né un purge (design:219-220) |
| NONE | 200 `NONE` e `legacyCount===0` | `VaultSetup` |
| NONE + migrazione | 200 `NONE` e `legacyCount>0` | `VaultMigrate` |
| READY | 200 `READY`, oppure GET fallita con `byUser` | `VaultUnlock` (offline solo se `offlineUnlock` e c'è `shareEnc`) |
| UNLOCKED | Chiavi dell'utente corrente | Contenuto + sheet "Impostazioni vault" (§5.4). Dopo lo sblocco online: `purgeApiCache()`, poi `vaultReconcile` |
| RESET_PENDING | 200 | "Vault non disponibile" (P3). Nessuna scrittura |

- La GET del keyring non passa mai dalla cache SW (T12). Offline, quindi, fallisce davvero e si arriva a UNKNOWN o alla cache `byUser`.
- 503 `unavailable`/`pepperMismatch`: con cache → offline; senza cache → UNKNOWN.
- 503 `setupDisabled` (canary): "Il nuovo vault sarà disponibile a breve; finora il tuo vault **non è accessibile** da questa versione" (D2). Il bundle nuovo non ha lo sblocco legacy.
- `lockedUntil > now` → conto alla rovescia; `lockedUntil <= now` = sbloccato (P1:625).
- `VaultPage` mantiene `lockVault()` all'unmount (`:179-184`). Grazie a `registerPreLock` l'ultimo salvataggio non si perde.

### 5.4 Setup, Kit, sblocco, cambio PIN (`lib/vaultSession.ts`)
- **Marker del Kit** (vale per setup e rigenerazione):
  - prima della POST/PUT si salva `pending{kind:'kit', escrowHash, confirmed:false}`;
  - quando l'utente conferma i 2 gruppi del Kit, il marker si cancella;
  - al riavvio con un marker presente si fa `GET`:
    - `escrowHash` uguale → banner "Il Kit non è stato confermato: rigeneralo" (azione disponibile da sbloccato). Il Kit **non** si ri-mostra (design:50);
    - diverso → il marker si cancella in silenzio.
- **Setup** (solo online):
  1. PIN + conferma + password dell'account (`routes/vault.ts:12`);
  2. Argon2id;
  3. generazione;
  4. wrap ed escrow;
  5. marker;
  6. `POST /keyring {expectedEpoch: GET.epoch, …}`.
  - **201:** cache `byUser`, unlock, `shareEnc` (se `offlineUnlock`), `purgeApiCache()`, poi `RecoveryKitSheet` (PDF, copia, riscrittura di 2 gruppi a caso; il setup non si chiude senza).
  - **409 `alreadySetup`:** `GET` (P1:620) → READY → "Vault già creato su un altro dispositivo: inserisci quel PIN". Marker cancellato, Kit locale mai mostrato.
  - **403** `invalidPassword`, **400** `invalidRootKey`, **503** `setupDisabled`: messaggio. Su 400/403/503 il marker pending `{kind:'kit'}` si cancella subito (G6).
  - Frasi di rischio (design:96, :192) nel setup.
- **Sblocco online:**
  1. `GET`;
  2. controllo di `kdfParams`;
  3. Argon2id → `authKey` → `POST /unlock` → `serverShare` → `KEK_pin` → unwrap di VK (AAD con `kdfCanon`, accettazione 10) → unwrap di `vkSigKey`;
  4. cache e `shareEnc`;
  5. `clearLegacy()`, `purgeApiCache()`.
  - Errori: 403 → "PIN errato"; 429 → `GET` per `lockedUntil`; 409 `notReady` → `GET`.
- **Sblocco offline:** `wrappedVkPin` + `shareEnc`; il tag GCM verifica il PIN; nessun lockout (design:241-243). Il reconcile gira al ritorno della rete.
- **Cambio PIN** (online, vault sbloccato, dallo sheet in `VaultPage`):
  1. PIN attuale (unlock online);
  2. nuovo PIN (policy);
  3. `payload = {rev, wrap:{kdf, kdfParams, pinSalt, wrappedVkPin, authKey}}` firmato **solo in memoria**; i `kdfParams` del nuovo wrap sono `DEFAULT_KDF` (così un `t` alzato in seguito si applica al primo cambio PIN) e la derivazione del nuovo PIN usa gli stessi;
  4. `pending{kind:'pin', rev, wrappedVkPinHash: hex(sha256(wrappedVkPin))}`;
  5. `PUT`.
  - 409 `staleRev` nella sessione: `GET`. Se `sha256(wrappedVkPin)` è uguale → riuscito; altrimenti si ricostruisce dal nuovo PIN ancora in memoria.
  - Al riavvio con un pending: `GET`, confronto → "Il nuovo PIN è attivo" oppure "Vale ancora il PIN precedente", poi il pending si cancella.
  - 503 `pepperMismatch`: messaggio.
  - `serverShare` non cambia (`vault.service.ts:326-333`). Un dispositivo offline accetta il vecchio PIN fino al ritorno online (design:252): va detto in UI.
- **Rigenerazione del Kit** (vault sbloccato + PIN riconfermato, dallo sheet in `VaultPage`, design:123, :162):
  1. nuovi `S_root`/`S_user`, escrow e `userShareUnderVk`;
  2. `payload {rev, escrow}` firmato;
  3. marker;
  4. **`PUT` prima**;
  5. **cerimonia dopo**, con il Kit in memoria.
  - **200** → cerimonia.
  - **409** → `GET`. `escrowHash` uguale → riuscito, cerimonia. Diverso → "Il Kit non è stato aggiornato (un altro dispositivo ha modificato il vault): rigeneralo". Nessuna affermazione sul Kit precedente.
  - Da bloccato l'azione non esiste (accettazione 6).
- **Impostazioni (`SettingsPage`, vault non necessariamente sbloccato):**
  - switch "sblocco offline": OFF → cancella `shares[userId]` e `byUser.wrappedVkPin`, mantiene `{status, epoch, offlineUnlock:false}` (accettazione 7); ON → al prossimo sblocco online;
  - "Rimuovi vault da questo dispositivo": rifiutato con item pending o failed su note vault; altrimenti `ConfirmDialog` e cancellazione di `byUser`, chiave e share, righe Dexie vault dell'utente e loro item;
  - "Come funziona il vault" (design:192);
  - link "Cambia PIN / Kit di recupero" che apre `/vault`.

### 5.5 Logout (TIER 2) e cache del SW
- `authStore.ts:76`: `resetVault()` diventa `lockVault(); clearLegacy(); void purgeApiCache();`. Copre `api.ts:36`, `:61` e `useKanbanRealtime.ts:154`.
- `vite.config.ts:65`: predicato **inline e senza riferimenti esterni** (generateSW lo serializza con `toString()` in `sw.js`): `urlPattern: ({url}) => url.pathname.startsWith('/api') && !url.pathname.startsWith('/api/vault/') && !/^\/api\/notes\/[^/]+$/.test(url.pathname)`. Niente import da `lib/swCachePolicy.ts` dentro la config.
  - Le richieste escluse vanno in rete senza handler.
  - Le note sono offline-first su Dexie, quindi `api-cache` per `GET /notes/:id` era ridondante.

### 5.6 Envelope, titoli, editor
- **Ogni item vault è un envelope, anche vuoto:** creazione = `encryptItem({t: untitled, c: '{"type":"doc","content":[{"type":"paragraph"}]}'})`, `title:''`, `isEncrypted:true`. `''` in Dexie vuol dire "non caricato".
- **Titoli:**
  - in Dexie restano `''`;
  - lista, ricerca (titolo + `siteUrl`/`username`) e ordinamento usano `decryptItem` in memoria;
  - promemoria → `vault.reminderGeneric` (D8).
- **`VaultNoteEditor`:**
  - campo titolo + `<Editor content onChange editable isVault />` senza `noteId`, `provider` né `collaboration`;
  - **controlli portati da `NoteEditor`:**
    - eliminazione definitiva (`permanentlyDeleteNote`, `ConfirmDialog`), come `NoteEditor.tsx:888`;
    - tag vault (`TagSelector` con `isVault`, `:586`);
    - pin (`:689`);
    - promemoria (`:654-679`);
    - "Togli dal vault" (solo NOTE).
  - Salvataggio con debounce di 1 s: `updateNote(id, {content: await encryptItem(...)})`, mai `title`. Ogni cambio chiama `touchVault`. `registerPreLock` fa il flush del debounce pendente con le chiavi catturate (§5.2).
  - Envelope oltre 2 MiB → toast `vault.tooLarge`, nessuna scrittura.
  - Registra il proprio id in `openVaultNoteIds` al mount e lo toglie all'unmount.
  - **Item NOTE non envelope** (legacy rimasto, per esempio oltre il limite di `/migrate`): vista **in sola lettura** con il solo "Togli dal vault" (uscita con plaintext + CAS, `note.service.ts:270-278`) e un avviso.
  - Niente versioni, AI, allegati né condivisione.
- **Credenziali:** `CredentialForm`/`CredentialCard` usano `vaultCodec`, con `c = JSON.stringify(CredentialData)`. `credentialTypes.ts` tiene `decryptCredential(content, pin)` legacy solo per la migrazione.

### 5.7 Sync (TIER 1): `syncService.ts` + `db.ts`
Tutti i punti 3-8 valgono **solo se `isV3Active`** (§5.0). Senza, il codice di oggi resta invariato (test h).
1. **`db.ts`:** `vaultBaseHash?: string` in `LocalNote`. Nessuna `version()`.
2. **Pull** (`:174-191`): preservare `vaultBaseHash` dalla riga esistente. Con T0 la pull chiede `/notes?includeTrashed=true&all=1`.
3. **Push NOTE UPDATE su riga `isVault`** (`:937-939`), se `'content' in item.data`:
   - `content = localNote.content`. Se non è un envelope → l'item resta pending con `lastError:'vault:notEnvelope'`;
   - `sha256(content) === vaultBaseHash` e dati solo `{content}` → nessuna chiamata, si passa per il ramo di successo;
   - altrimenti `api.put(..., {...item.data, content, baseHash: localNote.vaultBaseHash})` togliendo `title`.
4. **Push NOTE CREATE su riga `isVault`** (`:932-936`):
   - con un envelope in Dexie → `content` = Dexie, `title: ''`;
   - con contenuto non envelope → resta pending, `vault:notEnvelope`.
5. **Su 2xx:**
   - UPDATE: `vaultBaseHash = sha256(content inviato)`;
   - CREATE: `vaultBaseHash = sha256(res.data.content)`, anche nel ramo P2002 (`note.service.ts:86-92`);
   - **marcatura `synced`:** si legge `row.updatedAt` **prima** della PUT. Dopo il 2xx la riga diventa `synced` solo se `updatedAt` è invariato e non restano item della nota in coda. Altrimenti resta `updated` e la prossima push la porta.
6. **422 vault** (`:1196-1210`): `response.data.message` del tipo `errors.vault.<x>` su NOTE → `lastError = 'vault:'+x` (`conflict`, `stale`, `plaintextRejected`, `notReady`, `plaintextRequired`, `attachmentsBlocked`).
7. **Blocco per entità:** un item `failed` con `lastError` `vault:*` blocca gli item successivi della stessa nota, tranne DELETE (estensione di `:909-914`).
8. **`retryFailedSyncItems`** (`:1275-1340`):
   - salta gli item `vault:*` e ogni item su una riga `isVault` con `content` non envelope o `title` non vuoto: li risolve `vaultReconcile`;
   - CREATE vault con envelope dell'epoch in cache → `data = {...item.data, title:'', content, isEncrypted:true}`.
9. `handleContentDeferred` (`:621-656`) non si tocca. Per le note vault non scatta (`note.service.ts:296-298`): un test lo blocca.

### 5.8 `vaultReconcile` (dopo ogni sblocco online e al ritorno online con il vault sbloccato)
1. **Idratazione:** pagine di `POST /items` (100 alla volta). Per ogni item:
   - **saltare gli id in `openVaultNoteIds`**: l'editor aperto ha lo stato in memoria; il suo prossimo salvataggio usa il vecchio `vaultBaseHash` e, se il server è cambiato, prende 422 `conflict` → copia;
   - riga `synced` (o con `content===''`) e `contentHash ≠ vaultBaseHash` → transazione Dexie con `content` + `vaultBaseHash`;
   - riga dirty → non si tocca;
   - riga assente → si salta (la crea la pull);
   - all'apertura di una nota, la stessa cosa per quell'id, **prima** del mount dell'editor.
2. **Conflitti** (`vault:conflict`), una sola copia per nota:
   1. `POST /items {ids:[id]}`;
   2. decifratura del contenuto Dexie;
   3. nuova nota (uuid) con `{t: t+' '+i18n('vault.conflictCopySuffix'), c}` cifrata con il nuovo id, via `noteService.createNote`;
   4. poi, in una sola transazione Dexie (cifrature fatte prima), riga originale = server + `vaultBaseHash`, `synced`. Gli item della nota con chiavi ⊆ `{content,title,isEncrypted}` si cancellano; dagli item misti si tolgono `content`/`title` e tornano `pending`.
   - Se la nota non esiste più sul server: copia + cancellazione della riga.
3. **Righe e item legacy** (bundle vecchi, push pre-v3, design:318-321). Il passo prende **ogni** item `failed`/`pending` NOTE su una riga `isVault` che abbia `content` non envelope **o** `title` non vuoto, qualunque sia `lastError`.
   - Gli item solo-titolo forniscono `t` alla copia e si cancellano.
   - Con il contenuto in chiaro: se il server ha la nota → copia in conflitto come al passo 2. Le credenziali v2/legacy si decifrano con i vecchi PIN della sessione di migrazione, altrimenti restano "bloccate con un PIN precedente".
   - Se il server non ha la nota (CREATE mai arrivata) → ri-cifratura sul posto (stesso id) e refresh del payload CREATE.
4. **`legacyCount>0`** → banner "N elementi da aggiornare" che apre il wizard sui soli item rimasti.
5. **`finalize` da riprendere:** item envelope dell'epoch corrente con `hasPlaintextVersions` → decifratura + validazione strutturale (`v===1`; NOTE: `JSON.parse(c).type==='doc'`; CREDENTIAL: oggetto) → `POST /finalize` (al massimo 500 per chiamata).

### 5.9 Spostamento dentro e fuori dal vault (`lib/vaultMove.ts`, solo online)
- **Dentro** (sostituisce `NoteEditor.tsx:347-374` e il ramo `handleVaultToggle` di `:749`):
  0. **Stato del keyring:**
     - `NONE` (con o senza legacy), UNKNOWN o `setupDisabled` → navigazione a `/vault` (setup o wizard), **mai** una PUT in chiaro;
     - READY bloccato → `VaultUnlockDialog`.
  1. **Chiusura pulita dell'editor sorgente:**
     - `movingRef.current = true` mette in corto circuito i due effetti di salvataggio (`NoteEditor.tsx:191-252`);
     - flush esplicito di `titleInput`/`contentInput` via `saveNote`, poi `await syncPush()`, poi attesa di zero item pending sulla nota (altrimenti messaggio);
     - controllo degli allegati (altrimenti `errors.vault.attachmentsBlocked`).
  2. `GET /notes/:id` → `server.content` (non passa dalla cache SW, T12).
  3. `env = encryptItem({t: server.title, c: server.content})`.
  4. Round-trip in memoria prima della PUT (P1:641).
  5. Revoca delle condivisioni come oggi.
  6. `PUT /notes/:id {isVault:true, content: env, title:'', baseHash: sha256(server.content)}`, chiamata diretta.
  7. `vaultMove.moveIn(id, {onCommitted})`: `NoteEditor` passa `onCommitted = () => { onClose(); queryClient.invalidateQueries(['note', id]) }`, invocata su 200 **prima** della scrittura Dexie; `lib/` non importa da `features/`. Su 200: **prima** `setSelectedNoteId(null)` (l'editor si smonta) e invalidazione della query della nota, **poi** riga Dexie `{isVault, isEncrypted:true, title:'', content: env, vaultBaseHash: sha256(env), syncStatus:'synced'}`.
  8. `POST /items {ids}` → decifratura → uguale? → `POST /finalize {ids}`.
  - 422 `conflict` → si riparte dal passo 2 (al massimo 2 volte). 422 `attachmentsBlocked` → messaggio. In caso di errore `movingRef` torna `false`.
- **Rete di sicurezza (T21a):** `noteService.updateNote` (`noteService.ts:149`) rifiuta, senza scrivere né accodare, ogni `data` che:
  - contiene la chiave `isVault`: solo `vaultMove` cambia `isVault` e scrive Dexie direttamente;
  - su una riga `isVault` porta `content` non envelope o `title` non vuoto.
  - `noteService.createNote` con `isVault:true` richiede un envelope e `title:''`.
  - Ogni rifiuto dà `console.warn` + errore tipizzato.
- **Fuori** (da `VaultNoteEditor`, solo NOTE):
  1. decifratura (o il contenuto legacy così com'è);
  2. `PUT {isVault:false, isEncrypted:false, content: c, title: t, baseHash: vaultBaseHash}`;
  3. su 200: prima la chiusura dell'editor, poi la riga Dexie in chiaro senza `vaultBaseHash`.
  - 422 `conflict` → reconcile della nota, poi l'utente ritenta.

### 5.10 Versioni e restore
- Le note vault non mostrano la cronologia.
- `VersionHistoryModal.tsx`: nasconde le versioni `nv3.` e traduce `errors.vault.{plaintextRejected,plaintextRequired,stale,notReady}`, `errors.notes.restoreConflict` e `restoreUnsupportedLive` (`:71-72`).

### 5.11 Allegati
- `VaultNoteEditor` non ha allegati.
- Le note vault legacy con allegati si migrano nel corpo e si segnalano (D3).

---

## 6. Migrazione dei vault in prod (zero perdita di dati)

È client-side: `features/vault/vaultMigration.ts` (logica pura) + `VaultMigrate.tsx`. Parte con `status:NONE && legacyCount>0` e solo online.

0. **Flush.** `syncPush()` e attesa di zero item **pending** sulle note vault (al massimo 30 s, poi "riprova").
   - Prima del keyring `isV3Active` è falso: i payload legacy, titoli compresi, partono **invariati** e il server li accetta (design:294). Il passo termina.
   - I `failed` non bloccano.
1. **Keyring** (§5.4 setup). Su 409 si sblocca con il PIN dell'altro dispositivo e si prosegue. Il client non manda `migrationState` (P1:35).
2. **Sorgente = server** (design:299): tutte le pagine di `POST /items`, filtrando il `content` non `nv3.`. **Titolo da `item.title`** (T1). **Mai `GET /notes`** (paginato, `routes/notes.ts:46`), mai Dexie.
3. **Classificazione:**
   - **NOTE** (`isEncrypted` true o false): `c` = `content` byte per byte; `t` = `item.title`.
   - **CREDENTIAL:**
     - `''` → `c = JSON.stringify(EMPTY_CREDENTIAL)` (`frontend/src/features/vault/credentialTypes.ts:13`);
     - JSON in chiaro (`JSON.parse` dà un oggetto, senza prefisso `v2:` né formato CryptoJS) → `c` = `content` byte per byte;
     - `v2:` e CryptoJS legacy (`crypto.ts:40-72`): uno o più vecchi PIN (campo ripetibile). Un PIN è valido se `decryptContent` restituisce non-null **e** `JSON.parse` dà un oggetto con chiavi `CredentialData`. Ogni PIN si prova su tutte le bloccate. PBKDF2 in `utils/legacyDecrypt.worker.ts` (circa 2 s per tentativo, HANDOFF:97). `c = JSON.stringify(parsed)`;
     - non decifrabile → byte-identica sul server, fuori da `/migrate`, marcata "Bloccata con un PIN precedente" (design:312, accettazione 14).
4. **Cifratura + round-trip in memoria** prima di ogni invio.
5. **`POST /migrate`:**
   - batch con al massimo 200 item e al massimo 12 MiB;
   - envelope oltre 2 MiB → `vault.migrateTooLarge`, item lasciato in chiaro e apribile in sola lettura con "Togli dal vault" (§5.6);
   - `baseHash = sha256hex(server.content)`;
   - esiti: `ok`/`already` → verifica; `conflict` → rifetch di quegli id e ritorno al passo 3 (al massimo 3 giri); `notFound` → si salta; `invalid` → stop.
6. **Verifica dai byte del server:** `POST /items {ids}`, decifratura, confronto **esatto** con gli originali in memoria. Solo gli id verificati vanno a `POST /finalize`.
7. **Chiusura:**
   - a) il server imposta `DONE` quando `legacyCount=0` (`vault.service.ts:527-536`);
   - b) `vaultReconcile` (§5.8 passi 1-3);
   - c) `clearLegacy()`, `purgeApiCache()`.
8. **Ripresa:** a ogni sblocco, §5.8 passi 4-5. Nessuno stato client.

**Casi particolari:**
- **2 dispositivi in contemporanea:** 201 + 409, il perdente sblocca con il PIN del vincitore. `/migrate` è idempotente (`already`), la CAS vale per item, `finalize` è idempotente (accettazione 15).
- **Note con allegati:** si migra il corpo e si segnala (D3).
- **Utenti legacy che non aprono mai il vault:** restano in chiaro (design:336). Il runbook li elenca via SQL.
- **Rollback di una nota migrata:** prima di `finalize` solo con SQL dell'admin da `NoteVersion` (P1:557); dopo, `pg_dump` (§11).

---

## 7. Contratti P1 vincolanti → task che li soddisfa

| # | Contratto (fonte) | Task |
|---|---|---|
| 1 | NFC prima di Argon2id (HANDOFF:89) | T5, T7 |
| 2 | Regex dell'envelope ed epoch corrente (P1:260, `vault.service.ts:49`, `:79`) | T7 |
| 3 | Lunghezze dei byte di `POST /keyring` + `password` (P1:244; `routes/vault.ts:10-29`) | T7, T13 |
| 4 | `vkProof` P1363, path costante, `rev ≤ 2147483646` (P1:407-409, :618) | T7, T13 |
| 5 | Mai 401; 403 `invalidPin`; 429 → `GET` (P1:245, :624) | T10, T13 |
| 6 | `lockedUntil <= now` = sbloccato (P1:625) | T13, T16 |
| 7 | 409 `alreadySetup` → `GET` (P1:620) | T13, T16 |
| 8 | 409 `staleRev` → `GET` + ricostruzione (P1:409) | T13 (marker + `escrowHash` di T1) |
| 9 | 503 `pepperMismatch` su `wrap` (P1:616) | T13 |
| 10 | Il client non manda `migrationState` (P1:35, :275) | T13, T20 |
| 11 | Guard non READY → 422 `notReady`/`stale` (P1:261-265) | T14, T17 |
| 12 | `baseHash` su `content` vault; titolo `''` (P1:351-355, :367) | T14, T18, T21a |
| 13 | Ingresso con envelope + CAS; allegati → 422 (P1:368, :649) | T2, T21 |
| 14 | Uscita con plaintext + CAS (P1:369, :643) | T18 |
| 15 | `createNote` vault: envelope e titolo `''` (P1:365) | T14, T17, T21a |
| 16 | `finalize` dopo il round-trip (P1:640) | T15, T20, T21 |
| 17 | Round-trip prima della PUT (P1:641) | T21 |
| 18 | Restore: nessun envelope su note non vault (P1:655) | T3, T23 |
| 19 | `/migrate` 200 item, 12 MiB, 2 MiB per item (P1:248, :634) | T20 |
| 20 | `/items` POST paginato (P1:247) | T10, T15 |
| 21 | Note vault legacy con allegati (P1:649) | T20 (D3) |
| 22 | Rollback amministrativo (P1:557, :597) | §11 |
| 23 | Chiavi root fissate + parità + rimozione del lock P1 (P1:446-449, :536) | T25 |
| 24 | `bodyLimit` di `PUT /notes` (P1:558) | T2 |
| 25 | T10 #3, T11-12 #2 (P1:642, :650-654) | §12 rischi 5-6 |
| 26 | Rate limit per utente (P1:632) | T10 |
| 27 | i18n di `errors.vault.*` (HANDOFF:108) | T24 |
| 28 | Vault fuori da `routeLive`/`rebaseYdocState` (`note.service.ts:296-298`, `:305`) | T2, T14 |
| 29 | `isEncrypted:false` su nota che resta nel vault → 422 `plaintextRejected`; uscita forza `isEncrypted=false` (P1 addendum T10 #4) | T18, T21a |
| 30 | `expectedEpoch` = `GET.epoch` intero 0..2147483647 (P1 addendum T6 #5) | T13 |
| 31 | `errors.vault.invalidPayload` su 400/413/415 (P1 addendum T9 #2) | T10, T24 |

---

## 8. File toccati e TIER

**⚠ Avviso multi-file (CLAUDE.md).**
- P2 tocca circa 50 file.
- Ogni file TIER richiede "proponi prima, applica dopo", la conferma dell'hook `tier1-guard` e, dopo `git add`, il gate con `reviewer` + `red-team`.
- Lo sviluppo avviene sul branch `feat/vault-p2`, unito su `main` solo al rilascio (RT-1).
- T0 sta dentro P2 (D12, esito del 21/10).

| TIER | File | Modifica | Approvazione |
|---|---|---|---|
| **1** | `frontend/src/store/vaultStore.ts` | T11 additivo; T24b rimozione dei legacy | **Sì** (2 volte) |
| **1** | `frontend/src/features/sync/syncService.ts` | T0 (`all=1`), T14 (§5.7) | **Sì** (2 volte) |
| **1** | `frontend/src/lib/db.ts` | Solo il tipo `vaultBaseHash?` | **Sì** |
| **2** | `frontend/src/store/authStore.ts` | `:76` | **Sì** |
| (1, non modificato) | `backend/src/hocuspocus.ts` | Solo `flushLiveDoc`, già importato (`note.service.ts:2`) | — |
| — | BE: `vault.service.ts`, `note.service.ts`, `routes/notes.ts`, `noteVersion.service.ts`, `utils/vaultRootKeys.ts`, `utils/vaultSeal.ts` (nuovo) + test | §4 | No (gate) |
| — | `frontend/vite.config.ts` | Esclusione dalla cache (T12) | No |
| — | `features/admin/VaultBenchPage.tsx` (nuovo), `App.tsx` (rotta `admin/vault-bench` fuori da `<AppLayout/>`), `AdminPage.tsx` (link) | T6 | No |
| — | `backend/src/services/vault.service.ts` (`KDF_T_MIN`, `:281`), `backend/src/routes/vault.ts` (`:16`, importa `KDF_T_MIN`) + test del keyring | `KDF_T_MIN = 3` introdotta in T1 (G1); il suo **valore** cambia solo nel ramo t>3 del runbook (§3, passo 7) | No (gate) |
| — | `frontend/package.json` (+ lock) | `hash-wasm ^4.12.0` | No |
| — | `features/notes/noteService.ts` | Guardie di T21a | No (gate) |
| — | Nuovi FE: `utils/{argon2.worker,argon2,vaultCrypto,vaultKit,vaultRootKeys,legacyDecrypt.worker}.ts`, `lib/{vaultApi,vaultSession,vaultMove}.ts`, `features/vault/{deviceKeyStore,vaultCodec,vaultReconcile,vaultMigration,PinPolicy,pinBlocklist,kitPdf}.ts`, `features/vault/{VaultMigrate,VaultNoteEditor,VaultOfflineNotice,VaultSettingsSheet}.tsx`, `components/vault/{RecoveryKitSheet,VaultUnlockDialog,VaultSettingsSection}.tsx` | §5-§6 | No |
| — | `features/vault/{VaultPage,VaultSetup,VaultUnlock,CredentialForm,CredentialCard}.tsx`, `credentialTypes.ts`, `useVaultHydration.ts` (rimosso) | §5 | No |
| — | `features/notes/NoteEditor.tsx`, `features/notes/NotesPage.tsx` (solo se NoteEditor non ha già una prop di chiusura), `VersionHistoryModal.tsx`, `RemindersPage.tsx`, `SettingsPage.tsx`, `App.tsx` | §5 | No |
| — | `locales/en.json`, `it.json`; `frontend/e2e/vault-*.spec.ts`; documentazione | — | No |

**Non toccati:** `crypto.ts`, `api.ts`, `Editor.tsx`, `ImageDrop.ts`, `hocuspocus.ts`, `utils/ydoc.ts`, `schema.prisma` e migration, `app.ts`, `email.service.ts`, `auth.service.ts`, `Build-Package.ps1`, `Deploy-Server.ps1`.

---

## 9. Task ordinati per subagent

**Regole comuni:**
- `model:"sonnet"`, al massimo 3 file di codice per task (più test e locale), solo il tool Edit, niente `git stash`. Ogni nuova funzione BE inizia con `if (!userId) throw`.
- **Ogni task chiude verde:**
  - BE: `cd backend && npm test && npx tsc --noEmit && npm run lint`;
  - FE: `cd frontend && npx vitest run && npx tsc -p tsconfig.app.json --noEmit && npm run lint`.
- Poi `git add`, poi `node "$HOME/.claude/jev-gate.mjs"`, poi revisori secondo il gate (TIER = reviewer + red-team, al massimo 2 round). Dopo ogni review con finding: "Addendum dopo la review di Tn". Con MAJOR ripetuti, prima `architect` sul modello complessivo (lezione 1.13.3).
- **Ordine:** T0, poi T1-T4, poi T5-T12, poi T13-T23 (T21a prima di T21), poi T24/T24b, poi T25, poi T26-T27.

| # | File | Contenuto | Criteri di accettazione e test |
|---|---|---|---|
| **T0** ⚠T1 | `routes/notes.ts`, `note.service.ts`, `syncService.ts` (`:118`) + test | §4.0; pull con `all=1` | BE: `?all=1` con 150 note mockate → 150; senza → 50 (invariato). FE: la pull chiede `all=1`; con 120 note sul server e 120 righe `synced` locali → 0 `bulkDelete`. Con fetch fallita → nessuna cancellazione (comportamento esistente) |
| **T1** | `vault.service.ts`, `routes/vault.ts` (`:16`, import di `KDF_T_MIN`), `__tests__/vault.keyring.test.ts` (root key mockate, `:8-9`), `__tests__/vault.service.test.ts` (`:286`), `__tests__/vault.items.test.ts` | §4.1 | `escrowHash` = vettore fisso: blob di 60 B `0x00..0x3b` → hex atteso calcolato con `createHash().update(Buffer)` e scritto come costante condivisa con T13. Body senza `escrowBlob`. Senza riga → `null`. `/items` contiene `title` e `hasPlaintextVersions` (true con 1 versione non-`nv3.`, false altrimenti). Kill switch: assente → 503 prima di bcrypt; `'u1'` → u1 passa, u2 503; `'*'` → passa. Il test "P1 lock" resta verde. **G1: `export const KDF_T_MIN = 3` in `vault.service.ts`, usata da `keyringUpdatePayloadSchema` (`:281`) e da `routes/vault.ts:16` (import); i test che scrivono `t:3` a mano (`vault.keyring.test.ts:38` e `:259`, `vault.service.test.ts:286`) usano la costante; test nuovi: `POST /keyring` con `kdfParams.t = KDF_T_MIN-1` → 400 e `PUT /keyring` con `wrap.kdfParams.t = KDF_T_MIN-1` → 400** |
| **T2** | `note.service.ts`, `routes/notes.ts`, `note.service.test.ts` | §4.2 | Con guard + doc live mockato → `flushLiveDoc` chiamato prima di `assertVaultContent`; la rilettura cambia `content` → 422 `conflict`. Flush che lancia → warn, la richiesta prosegue (CAS). **Senza guard** + doc live → `flushLiveDoc` non chiamato. CREDENTIAL in uscita senza keyring → `searchText` non ricalcolato. Payload con `content` di 2 MiB + altri campi (`tags`, `title`) oltre 2 MiB totali → non 413; `content` di 2 MiB+1 → 400. I test 1.13.3 restano verdi |
| **T3** | `noteVersion.service.ts`, `__tests__/vaultBypasses.test.ts` | §4.3 | Restore vault con `content` cambiato → 409. Versione `nv3.` su nota non vault → 422, nessuno snapshot. Restore normale invariato |
| **T4** | `utils/vaultSeal.ts`, `__tests__/vaultSeal.test.ts` | §4.4 | Round-trip; alterazioni → errore; 157 B; vettore V1 esportato |
| **T5** | `package.json`, `utils/argon2.worker.ts`, `utils/argon2.ts`, test | §3, §5.1 | KAT su **`argon2Raw`** identico a `vaultRootKeyFile.test.ts:229-264` (t=2, m=1024). `deriveS` rifiuta `m:32768`, `t:2`, `p:2`. `argon2Raw` con stringa NFD (`'e\u0301…'`) dopo NFC = hash della forma NFC. Build: chunk worker, nessun `.wasm`. `DEFAULT_KDF` esportata. **Dopo rifiuto o timeout: `worker.terminate()` e Worker ricreato alla chiamata seguente; test che fa fallire la prima chiamata e verifica che la seconda riesca. G2: `resetArgon2Worker()` esportata (terminate + riferimento a null, ricreazione lazy); test "dopo reset la chiamata seguente crea un Worker nuovo". H5: test "`deriveS` in volo + reset → rifiuto immediato con `kdfFailed`; la chiamata seguente riesce"** |
| **T6** | `features/admin/VaultBenchPage.tsx` (nuovo, default export lazy), `App.tsx` (rotta `admin/vault-bench` accanto alla rotta `admin`, FUORI da `<AppLayout/>`: `App.tsx:89`, così `useSync` di `AppLayout.tsx:22` non gira durante la misura), `AdminPage.tsx` (link), `en.json`/`it.json`, test | Benchmark Argon2id in prod, solo SUPERADMIN (D13). Dettaglio sotto la tabella | Vedi "Dettaglio T6" sotto la tabella |
| **T7** | `utils/vaultCrypto.ts`, test (`@vitest-environment node`), `backend/__tests__/vaultSeal.test.ts` (V2) | §3 | Lunghezze uguali allo Zod P1. Round-trip; AAD cambiata → errore; `stale`; `kdfCanon` indipendente dall'ordine; `kdfParams` manomessi → unwrap fallisce; `vkProof` verificato con `node:crypto.verify(..., ieee-p1363)`; V1 in WebCrypto, V2 con `openRootShare`; regex `:49`. `contentHash` = `sha256hex` del BE sulla stessa stringa |
| **T8** | `utils/vaultKit.ts`, `kitPdf.ts`, test | Kit, PDF a mano (D9) | 32×31 sostituzioni + 31 scambi rilevati; normalizzazione; PDF `%PDF-1.4` di 1 pagina |
| **T9** | `PinPolicy.ts`, `pinBlocklist.ts`, test | Policy | Rifiutati: `123456`, `abcdef`, `k7Rq2`, `k7Rq2xZ`, `Marco1`, `luca99`, `2024ab`, `qwer12`, `a1a1a1`, `a1b2c3`, `1203ab`, nome/email. Accettato: `k7Rq2x`. Blocklist in un chunk separato |
| **T10** | `lib/vaultApi.ts`, test | §5.1 | Mapping per 400/403/409/422/429/503; 429 su `/items`/`/migrate` → 1 retry con backoff; `POST /keyring` con `password`, senza `migrationState` |
| **T11** ⚠T1 | `store/vaultStore.ts`, test | §5.2, **additivo** | Chiave invariata; lo storage vecchio si carica (`byUser={}`); `partialize` senza chiavi né `isUnlocked`. `lockVault` chiama i flusher con le chiavi catturate **prima** di azzerarle (test: il flusher riceve chiavi non nulle, lo store ha già `keys===null`). Auto-lock a 10 min. Chiavi di u1 non disponibili per u2. **I campi legacy esistono ancora** (`tsc` verde senza toccare i consumatori) |
| **T12** ⚠T2 | `store/authStore.ts`, `vite.config.ts` + test | §5.5 | `logout()` → `lockVault` + `clearLegacy` + `purgeApiCache` (`caches.delete('api-cache')` mockato); `byUser` intatto. Test che importa la config, prende `runtimeCaching[0].urlPattern`, la ricostruisce con `new Function('return ' + fn.toString())()` (stessa serializzazione di workbox) e verifica `/api/notes` true, `/api/notes/abc` false, `/api/vault/keyring` false, `/api/notebooks` true; dopo `npm run build`, `grep -c "api/vault/" dist/sw.js` ≥ 1 |
| **T13** | `deviceKeyStore.ts`, `lib/vaultSession.ts`, test | §5.4 | Setup: marker salvato prima della POST; 201 → cache + share + Kit dopo il 201 + `purgeApiCache`; 409 → nessun Kit, `GET`. Unlock: 403, 429 → `GET` + `lockedUntil`, `lockedUntil` passato → ok. Switch OFF → nessuno share. **Setup e cambio PIN: i `kdfParams` del nuovo wrap sono `DEFAULT_KDF` (test con la costante, non il letterale; test che la sostituisce con t=4 e verifica il wrap).** **G6: setup con 400/403/503 → il marker `pending{kind:'kit'}` è cancellato subito (assert sullo store raw).** **Rigenerazione: PUT prima della cerimonia**; 409 + `escrowHash` uguale (stesso vettore di T1 lato FE) → successo; diverso → `kitNotUpdated`. Marker non confermato + `GET` uguale al riavvio → banner. **Pending PIN senza `authKey`** (test: nello store raw non ci sono 32 B di `authKey` né il payload) |
| **T14** ⚠T1 | `lib/db.ts`, `syncService.ts`, test | §5.7 | (a) La pull preserva `vaultBaseHash`. (b) UPDATE v3: `content` Dexie + `baseHash`, senza `title`. (c) 3 edit offline + CREATE di un tag → 1 PUT, 0 `failed` (accettazione 11). (d) `vaultBaseHash = sha256(inviato)`; riga modificata durante la PUT → resta `updated`; `updatedAt` invariato e nessun altro item → `synced`. (e) 422 `conflict` → `vault:conflict`, UPDATE successivi bloccati, DELETE sì. (f) Il retry salta `vault:*` e gli item legacy su righe vault. (g) CREATE → `sha256(res.data.content)`. (h) Righe non vault: payload byte-identici. **(i) Senza keyring READY in cache: UPDATE vault con `content` in chiaro e `title` → payload inviato invariato; CREATE vault con titolo → titolo inviato invariato.** (j) `grep -c "version(" db.ts` invariato |
| **T15** | `vaultCodec.ts`, `vaultReconcile.ts`, test | §5.6, §5.8 | Idratazione `synced` → aggiornata; dirty → no; **id in `openVaultNoteIds` → non toccato**. 2 `vault:conflict` → 1 copia. **Item solo-titolo con `lastError:'validation'` su riga vault → preso, `t` nella copia, item cancellato.** CREATE legacy senza nota sul server → ri-cifrata sul posto. `finalize` solo con decifratura valida. Cache svuotata al lock |
| **T16** | `RecoveryKitSheet.tsx`, `VaultSetup.tsx`, `VaultUnlock.tsx` | §5.4 UI | Kit solo dopo il 201; "Fine" disabilitato finché i 2 gruppi non sono corretti; setup offline disabilitato; frase di rischio; niente reset locale; "PIN dimenticato" (D5); bottom sheet, `dark:`, 44 px, `aria` |
| **T17** | `VaultPage.tsx`, `VaultOfflineNotice.tsx`, rimozione di `useVaultHydration.ts` | §5.3 | UNKNOWN, mai il setup; `NONE` + 2 → wizard; READY → unlock; `setupDisabled` → testo "non accessibile"; creazione → envelope + `title:''`; ricerca decifrata; `grep -n "importFile" VaultPage.tsx` vuoto; il lock all'unmount resta |
| **T18** | `VaultNoteEditor.tsx`, `lib/vaultMove.ts` (uscita), test | §5.6, §5.9 | Nessun `noteId`/`provider`/`collaboration`. Il salvataggio usa un envelope senza `title`. **Controlli presenti e funzionanti: elimina definitivamente (`permanentlyDeleteNote` + `ConfirmDialog`), `TagSelector isVault`, pin, promemoria.** Item non envelope → sola lettura con il solo "Togli dal vault". Lock con debounce pendente → l'envelope viene scritto (flusher). Registrazione e rimozione in `openVaultNoteIds`. Uscita: plaintext + `isEncrypted:false` + `baseHash` |
| **T19** | `CredentialForm.tsx`, `CredentialCard.tsx`, `credentialTypes.ts` | §5.6 | Envelope con `t`; nessun `title`; `decryptCredential` legacy senza store; test P0 verde |
| **T20** | `vaultMigration.ts`, `VaultMigrate.tsx`, `legacyDecrypt.worker.ts` | §6 | **Titolo da `/items.title`: un item legacy non presente fra le prime 50 note viene migrato con il suo titolo** (test: `GET /notes` mai chiamato). Batch 250 → 200+50; 12 MiB; oltre 2 MiB escluso; `conflict` → rifetch; `finalize` solo sugli id verificati; PIN errato → fuori; 2 PIN diversi → entrambe migrate; **CREDENTIAL `''` → `c = JSON.stringify(EMPTY_CREDENTIAL)` (`credentialTypes.ts:13`) e JSON in chiaro → migrate**; pending → attesa; failed → nessun blocco |
| **T21a** | `features/notes/noteService.ts` + test | §5.9 rete di sicurezza | `updateNote(id,{isVault:true})` → rifiutato, Dexie e coda invariati. Su riga `isVault`: `{content:'{"type":"doc"…}'}` → rifiutato; `{title:'x'}` → rifiutato; `{content:'nv3…'}` → accettato. `createNote({isVault:true, title:'x'})` → rifiutato. Su riga `isVault`: `{isEncrypted:false}` → rifiutato (Dexie e coda invariati). Note normali invariate |
| **T21** | `NoteEditor.tsx` (`:191-252`, `:347-374`, `:749`), `VaultUnlockDialog.tsx`, `lib/vaultMove.ts` (ingresso) + `NoteEditor.vault.test.tsx` | §5.9 | Test esistente invertito (PUT con `nv3.`, `baseHash`, `title:''`). **Testo digitato meno di 1 s prima di "sposta" → il flush avviene prima della GET, nessun `updateContent` in chiaro dopo il 200 (debounce finto); `setSelectedNoteId(null)` prima della scrittura Dexie.** `NONE` → navigazione a `/vault`, nessuna PUT. Offline → disabilitato. Allegati → messaggio. Round-trip prima della PUT; `finalize` dopo la rilettura |
| **T22** | `VaultSettingsSheet.tsx` (in `VaultPage`), `components/vault/VaultSettingsSection.tsx`, `SettingsPage.tsx` | §5.4 | Sheet (da sbloccato): cambio PIN, rigenerazione del Kit. Settings: switch offline, rimozione (rifiutata con pending), "Come funziona", link a `/vault`. `ConfirmDialog` |
| **T23** | `VersionHistoryModal.tsx`, `RemindersPage.tsx` | §5.10, D8 | Versioni `nv3.` nascoste; errori tradotti; etichetta generica |
| **T24** | `en.json`, `it.json`, `i18nVaultKeys.test.ts` | Tutti gli `errors.vault.*` (incluso `invalidPayload`, assente oggi: H6) + `setupDisabled` + testi nuovi | Presenza in entrambi i file |
| **T24b** ⚠T1 | `store/vaultStore.ts`, `credentialTypes.ts` + test | Rimozione di `pin`, `setupVault`, `unlockVault`, `resetVault` e del `cachePut` legato al PIN (`credentialTypes.ts:35-40`) | `grep -rn "resetVault\|unlockVault\|setupVault\|\.pin\b" frontend/src` vuoto (escluse le occorrenze legacy di `decryptCredential`); `tsc` verde |
| **T25** ⚠ RT-1 | `backend/utils/vaultRootKeys.ts`, `frontend/utils/vaultRootKeys.ts`, test di parità, `vault.service.test.ts` (`:276-277`) | Chiave `rk_68a265761e7e37c7` (SPKI dall'utente) | Parità; id = `rk_+sha256(ecdhSpki‖ecdsaSpki)[0:16]`; secp384r1; `grep -rn "rk_e434f78b8f179ab3"` vuoto; commit unico |
| **T26** | `frontend/e2e/vault-{kit,multidevice,offline,migration,conflict}.spec.ts`, `vault-overwrite.spec.ts` | §10 | Verdi in locale (`VAULT_SETUP_USERS=*`) |
| **T27** | `CLAUDE.md`, `SKILL.md` deploy, design | Documentazione + runbook §11 | Revisione |

**Dettaglio T6 (benchmark in prod, D4, D13).**
- **Guard:** nessun utente → `<Navigate to="/login" replace/>`; `user.role !== 'SUPERADMIN'` → `<Navigate to="/notes" replace/>`. L'enum è `USER|SUPERADMIN` (`schema.prisma:90-93`, `Sidebar.tsx:200`), non esiste `ADMIN`. Il controllo è solo lato client ed è accettabile: la pagina non contiene segreti e non chiama API. Un non-SUPERADMIN può caricare il chunk, ma non trova nulla.
- **Contesto:** se `!window.isSecureContext || !crypto?.subtle` → messaggio e pulsante "Avvia" disabilitato.
- **Input fittizi:** PIN `k7Rq2x`, salt di 16 B da `crypto.getRandomValues`. Chiama `deriveS` di T5 (stesso percorso dello sblocco), m=65536, p=1.
- **Sequenza (F9):** t=3..10 in ordine crescente. Ci si ferma dopo il primo t che viola uno dei due vincoli di D4. Un errore o OOM del Worker viene annotato per quel t e conta come violazione.
  - Campioni a caldo: N=20 per t.
  - Campioni a freddo: 3 per t. Prima di ogni campione a freddo si chiama `resetArgon2Worker()` (T5), poi `deriveS` (stesso percorso dello sblocco); si prende il peggiore.
  - **H7:** dopo ogni `resetArgon2Worker()` si attende un breve yield (250 ms) prima della `deriveS` a freddo. Su errore/OOM di un campione a freddo, il campione si ripete UNA sola volta prima di contarlo come violazione; il JSON annota i retry (campo `retries` per t).
  - **Criterio vitest (G2, H4):** con spy condivisi, l'ordine delle chiamate (`mock.invocationCallOrder`) è reset, deriveS, reset, deriveS, reset, deriveS per ogni t; nessuna deriveS a freddo senza un reset immediatamente precedente.
- **Statistiche:** mediana; p95 nearest-rank (il 19° di 20 valori ordinati); min e max.
- **Rilevamento:** `matchMedia('(display-mode: standalone)').matches || navigator.standalone` (Safari o PWA); `navigator.userAgent`; versione dell'app; due campi di testo "modello" e "iOS" (precompilato dall'UA), non salvati.
- **Output (F11, F13):** JSON in una `<textarea readonly>` più il pulsante "Copia" (`navigator.clipboard.writeText`, con fallback select-all).
  - Il JSON contiene anche `DEFAULT_KDF` e il nome dell'entry `index-*.js` (es. da `document.querySelector('script[type="module"][src*="/assets/index-"]')`).
  - La textarea si aggiorna in modo incrementale (dopo ogni campione, o almeno dopo ogni t), con t crescente, e c'è un pulsante "Stop".
  - Su iOS un OOM vero ricarica la pagina e il bench non salva su storage (vincolo sotto): per questo la verifica manuale 1 prevede uno screenshot dopo ogni t.
- **Vincoli:** nessun import di `lib/db`, `syncService`, `lib/api`; nessun `localStorage`/`sessionStorage`/`caches`; nessuna rete.
- **UI:** `dark:` su ogni elemento, controlli `min-h-[44px] min-w-[44px]`, `aria-label`, safe area, tutte le stringhe via `t()`.
- **Criteri di accettazione:**
  - Vitest con utente assente → redirect a `/login`; ruolo `USER` → redirect a `/notes` e `deriveS` mai chiamato; `SUPERADMIN` → pagina renderizzata; `isSecureContext=false` → "Avvia" disabilitato.
  - Corsa completa con `deriveS` mockato e `@/lib/db`, `@/lib/api`, `localStorage.setItem` e `caches.open` mockati in modo da lanciare → nessun lancio. Il JSON contiene, per ogni t eseguito, `n=20`, `median`, `p95` (uguale al 19° valore), `cold` (3 campioni e il peggiore), `errors`, più `DEFAULT_KDF` e l'entry. Test di arresto: un t che viola un vincolo ferma la sequenza. Test della scrittura incrementale e del pulsante Stop.
  - `grep -nE "lib/db|syncService|lib/api|localStorage|sessionStorage|caches\." frontend/src/features/admin/VaultBenchPage.tsx` → vuoto. `git diff --stat` di T6 senza `vite.config.ts`.
  - La rotta sta fuori da `<AppLayout/>` (test di rendering: `useSync` non montato).
  - `i18nVaultKeys.test.ts` (T24) copre `vaultBench.*` in `en.json` e `it.json`.
  - Verde su `npx vitest run`, `npx tsc -p tsconfig.app.json --noEmit`, `npm run lint`.

---

## 10. Piano di test

**Unit BE:** T0-T4, T25. Concorrenze su DB reale, **dopo T25** (senza chiavi root `createKeyring` risponde 503, `vault.service.ts:207`):
- 2 `POST /keyring` paralleli → 201 + 409;
- `/migrate` da 2 client.

Si fanno a mano sul DB dev e si annotano nell'addendum.

**Unit FE:** T0, T5, T6, T7-T15, T16-T22, T24, T24b. `vaultCrypto` gira in ambiente `node`.

**E2E nuovi** (Playwright, `localhost:5173`):
- **`vault-kit`:** setup, Kit dopo il 201, gruppo sbagliato → non chiude. Rigenerazione **dallo sheet in `VaultPage`**, `escrowHash` diverso. Da bloccato l'azione non c'è.
- **`vault-multidevice`:** A fa il setup; B chiede il PIN e decifra; `K7rQ2X` non sblocca; logout/login → sblocco.
- **`vault-offline`:**
  - sblocco, offline, reload, sblocco offline, edit in coda;
  - switch OFF + reload offline → avviso, nessuno share in `notiq-vault-device`;
  - contesto nuovo offline → UNKNOWN.
  - La Cache Storage la copre il test del predicato serializzato (T12), più la verifica manuale 5 (in dev il SW di solito non è attivo).
- **`vault-migration`:**
  - seed via REST prima del keyring: 2 note in chiaro, **una delle quali più vecchia di 60 note filler** (per il titolo), 1 credenziale `v2:`, 1 credenziale passphrase, 1 credenziale con PIN non fornito, 1 credenziale `''`;
  - wizard;
  - verifica via API: tutti `nv3.` tranne quella bloccata; decifratura uguale, **titoli compresi**; nessuna versione non-`nv3.` per gli id finalizzati.
- **`vault-conflict`:**
  - A offline, B online → 1 copia, nessuna perdita (accettazione 12);
  - variante "bundle vecchio": riga non synced non envelope + item `failed` + item solo-titolo → 1 copia (accettazione 16);
  - variante "editor aperto": A ha la nota aperta, B salva, A torna online e salva → copia in conflitto, nessuna sovrascrittura silenziosa.
- **`vault-overwrite`:** adattato.

**Da rilanciare:** `offline-first`, `dexie`, `encryption`, `notes`, `collaboration`, `sharing`. Instabili noti: `collaboration.spec.ts:249`, `:288`, `auth.spec.ts:41`. Un FAIL va confermato su `main` pulito.

**Manuali:**
1. **Benchmark iOS** (T6, D4, D13), in prod dopo il passo 5 del runbook, con `VAULT_SETUP_USERS` vuoto, sull'iPhone di riferimento (iPhone 12 o più recente, A14+; se ne hai più d'uno, il più vecchio).
   - Prima in Safari, poi nella PWA installata; schermo sempre acceso e nessun'altra app in primo piano.
   - Rotta `/admin/vault-bench`, account SUPERADMIN. t=3..10 in ordine crescente, a 64 MiB; si ferma dopo il primo t che viola un vincolo.
   - **Screenshot dopo ogni t** (su iOS un OOM vero ricarica la pagina e il bench non salva su storage per vincolo).
   - Si copia il JSON (mediana e p95 a caldo, campioni a freddo, `DEFAULT_KDF`, entry, modello, iOS, standalone) e lo si incolla nell'addendum D4.
   - **t scelto = il massimo che rispetta ENTRAMBI i vincoli, in Safari E nella PWA:** p95 a caldo ≤ 1,5 s (20 campioni) e sblocco a freddo ≤ 2 s (3 campioni, il peggiore). Minimo 3. Se t=3 non li rispetta → ramo STOP del runbook (passo 7). Se esiste un solo iPhone A14+ più recente del 12, il margine resta ignoto e va dichiarato nell'addendum.
2. **Cross-device:** cambio PIN su PC; il telefono offline accetta il vecchio PIN, online il nuovo.
3. **Accettazione 4** (policy).
4. **Kill switch:** 503 `setupDisabled` + testo.
5. **Cache SW** (build di prod, `vite preview` o prod): DevTools → Cache Storage `api-cache` senza `/api/vault/` né `/api/notes/<id>`; dopo il logout `api-cache` non c'è.

---

## 11. Runbook di rilascio P2

**Punto di non ritorno:** il primo keyring READY in prod. Prima si torna al `dist` precedente; dopo, forward-fix, `pg_dump` o SQL per utente prima di `finalize` (D6).

1. **Locale:** BE e FE `test`/`tsc`/`lint`/`build`; e2e completi + i 5 nuovi; T6 verde; D4 si chiude al passo 6 (misura in prod); T25 con gli SPKI reali.
2. **Pre-deploy, in prod:**
   - `SELECT count(*) FROM "VaultKeyring";` → 0;
   - `SELECT "userId", count(*) FROM "Note" WHERE "isVault" AND content NOT LIKE 'nv3.%' GROUP BY 1;` → annotare;
   - `SELECT n.id FROM "Note" n WHERE n."isVault" AND EXISTS (SELECT 1 FROM "Attachment" a WHERE a."noteId"=n.id);` → note vault con allegati (D3);
   - `SELECT "userId", count(*) FROM "Note" GROUP BY 1 HAVING count(*) > 50;` → utenti toccati da T0;
   - controllo dei lock su `"User"`.
3. **`.env` di prod:** `VAULT_SETUP_USERS=` vuoto o assente → 503 `setupDisabled` per tutti. Quindi nessun keyring READY può nascere prima del passo 8.
4. **Pacchetto (primo deploy, senza tag):**
   - `git log --oneline v1.13.3..HEAD`;
   - `Build-Package.ps1`, poi `Deploy-Server.ps1 -DryRun`, poi `Deploy-Server.ps1`;
   - il `pg_dump` deve completarsi; `migrate deploy` → "No pending migrations"; health check ok;
   - **annotare il timestamp `ts1` di `_backup_<ts1>`:** il rollback pre-P2 è sempre `_backup_<ts1>` (non quello del secondo deploy, che contiene già il primo `dist` P2);
   - annotare SHA256 e entry `index-*.js` del pacchetto nell'addendum D4 (i due zip hanno la stessa versione in `frontend/package.json`).
5. **Bundle:** si verifica che sia servito l'entry nuovo (hash `index-*.js`), poi hard reload. Su questo IIS un asset mancante risponde 200 con `index.html`.
6. **Misura (D4, D13):** verifica manuale 1 (§10) dal SUPERADMIN, con `VAULT_SETUP_USERS` ancora vuoto. Poi `SELECT count(*) FROM "VaultKeyring";` → 0.
7. **Correzione:**
   - se t=3: niente;
   - se t>3: un unico commit con `DEFAULT_KDF.t` (§3) e il solo valore di `KDF_T_MIN` in `vault.service.ts` (usata da `routes/vault.ts:16` e `vault.service.ts:281`, F2/G1). **Verifica esplicita (G5):** commit fatto; `vault.keyring.test.ts` e `vault.service.test.ts` verdi; la verifica "POST e PUT con `t < KDF_T_MIN` → 400" è coperta dai test di T1 (`kdfParams.t = KDF_T_MIN-1` → 400 su POST e PUT), che devono passare verdi col nuovo valore di `KDF_T_MIN`; nessuna chiamata contro prod. Poi `Build-Package.ps1` e `Deploy-Server.ps1` (secondo deploy, `pg_dump` incluso: non usare `-SkipDbBackup`). Verifica del nuovo `index-*.js` con hard reload e smoke: il JSON del bench mostra `DEFAULT_KDF.t` = t scelto e la nuova entry. Annotare SHA256 e entry anche di questo pacchetto;
   - se OOM o violazione dei vincoli D4 già con t=3: **STOP**. Rollback del `dist` da `_backup_<ts1>` (ammesso, perché non esiste nessun keyring) e si torna dall'utente;
   - il tag git va solo sul pacchetto finale.
8. **Canary SUPERADMIN:**
   - `VAULT_SETUP_USERS=<id SUPERADMIN>` + `pm2 restart notiq-backend`;
   - prima del setup, sul dispositivo del canary (browser del PC): hard reload, aprire il bench e verificare che `DEFAULT_KDF.t` e l'entry siano uguali a quelli del pacchetto deployato (il pavimento server di F2 resta la rete di sicurezza);
   - migrazione nel browser;
   - `SELECT content ~ '^nv3\.' AS env, title='' AS t, "searchText" IS NULL AS s, "ydocState" IS NULL AS y, count(*) FROM "Note" WHERE "userId"='<admin>' AND "isVault" GROUP BY 1,2,3,4;` → solo `true`, tranne le bloccate o quelle troppo grandi elencate;
   - `SELECT count(*) FROM "NoteVersion" v JOIN "Note" n ON n.id=v."noteId" WHERE n."userId"='<admin>' AND n."isVault" AND v.content NOT LIKE 'nv3.%';` → 0;
   - **i titoli si vedono decifrati** nella lista vault;
   - `SELECT "migrationState" …`;
   - telefono: sblocco con il PIN, offline ok;
   - rigenerazione del Kit → `md5("escrowBlob")` diverso;
   - Cache Storage come nella verifica manuale 5.
9. **Apertura:** `VAULT_SETUP_USERS=*`, poi `pm2 restart notiq-backend` (dotenv si legge al boot, `app.ts:1`). Fra i passi 4 e 9 gli altri utenti legacy **non accedono** al vault: ridurre la finestra al minimo.
10. **Dopo l'apertura:**
    - query legacy settimanale; contattare chi non ha migrato;
    - `legacyCount` comprende il cestino, le credenziali bloccate e gli item oltre 2 MiB (§12.7);
    - retention dei dump con plaintext (design:335).
11. **E2E dopo eventuali hotfix:** §10.

**Finestra (conseguenza di D2).** L'account con vault legacy non apre il vault, né online né offline, dal passo 4 all'apertura del canary (passo 8). Stima: deploy 30' + misura 30-45' + secondo deploy eventuale 30' + canary 1-2 h, quindi 2-4 h, al massimo 1 giorno lavorativo. Riguarda 1 solo account: quello dell'utente, lo stesso SUPERADMIN che fa il canary (confermato 21/10). Nessun avviso ad altri utenti.

**Rollback:**
- Prima del passo 8: `dist` da `_backup_<ts1>` (il backup del primo deploy). T0 è retrocompatibile (`all` opt-in).
- Dopo:
  - utente singolo prima di `finalize`: SQL dell'admin (`UPDATE "Note"` dalla `NoteVersion` più recente non-`nv3.`, con `isEncrypted` d'origine, poi `DELETE FROM "VaultKeyring" WHERE "userId"=…`);
  - altrimenti `pg_dump`.

---

## 12. Rischi, residui accettati, domande aperte

1. **PIN dimenticato prima di P3/P4:** il vault resta bloccato. Testo esplicito; P3 subito dopo (D5).
2. **OOM di Argon2 su iOS:** misura in prod in https prima del canary (T6, §11, passo 6). Con OOM o vincoli violati già a t=3 si fa il rollback del `dist` (passo 7, ramo STOP). La riduzione di `m` sotto 64 MiB è vietata da §3 (controllo `kdfParams`) e richiede una decisione nuova.
3. **Dispositivo rubato con cache offline:** è il rischio principale (design:591). Il cambio PIN non invalida la cache rubata; la rotazione di VK è rimandata (D1). Residuo dichiarato.
4. **Bundle o SW manomessi, operatore con DB + pepper:** residuo di design (§9.1-9.2).
5. **TOCTOU P1 T10 #3: accettato.** Il plaintext che perde la gara torna `legacyCount>0` e il reconcile lo ri-migra.
6. **P1 T11-12 #2 (b, c): accettati.** Il punto (a) è chiuso da 1.13.2 + T3.
7. **`legacyCount` conta il cestino, le credenziali bloccate e gli item oltre 2 MiB:** `DONE` può non arrivare. Il client usa `legacyCount`. Va scritto nel runbook.
8. **Verifica di `finalize` nella ripresa** solo strutturale: accettato.
9. **Reconcile = scaricare tutti gli envelope a ogni sblocco online:** accettabile oggi.
10. **Logout spurio:** blocca il vault; lo sblocco offline resta disponibile.
11. **Item `vault:*` nel banner della sync:** "riprova" non li riattiva; va detto nel testo.
12. **Metadati in chiaro:** tag, `noteType`, `reminderDate`, `isPinned`, `notebookId`, timestamp, screenshot `siteUrl`, favicon. Accettati (§9.11, §10.6).
13. **CSP della SPA assente:** backlog. Quando arriverà: `script-src 'self' 'wasm-unsafe-eval'` + `worker-src 'self'`.
14. **Bundle 1.13.x in cache dopo il keyring:** i 422 compaiono come banner generico fino all'aggiornamento del SW. Gli item che lascia li assorbe il passo 3 del reconcile.
15. **`bulkPut` di tutte le note a ogni pull** (HANDOFF §3.2): con `all=1` il costo cresce col numero di note. Rimandato: un ticket dopo P2, solo se misurato.
16. **Peso di `GET /notes?all=1`:** è il comportamento di prima di 73ae89a (la lista è senza `content`). Il conteggio del runbook al passo 2 lo verifica.
17. **Kit non confermato:** se la pagina muore fra il 200 e la conferma, l'utente ha un Kit valido ma non visto. Il marker propone di rigenerarlo; il Kit non si ri-mostra (design:50).
18. **Chiusa (21/10):** in prod nessun utente ha più di 50 note (la query del passo 2 ha dato 0 righe). T0 resta dentro P2, senza hotfix 1.13.4 (D12).
19. **Fuori P2, già tracciati:** rate limit globale per IP aggirabile e richieste non autenticate su `/api/vault/*` (P1 addendum T9 #1, #4); vincoli P3/P4 (P1 addendum T1 #1-#2, #4; T6 #6).
20. **Secondo deploy per `t` (D13): Opzione A.** `DEFAULT_KDF` resta costante nel bundle (`utils/argon2.ts`, T5). Se la misura dà t≠3 serve un secondo deploy prima del canary. È sicuro: con `VAULT_SETUP_USERS` vuoto `createKeyring` risponde 503, quindi non esiste nessun keyring READY.
    - **Opzione B respinta** (default `t` dal server via env).
      - Sicurezza: un server malevolo potrebbe abbassare `t` solo fino al pavimento 3, perché il client rifiuta `t<3` e `m<65536` (§3). Il costo per tentativo cala al massimo di un fattore t_finale/3. Il tetto t≤10 limita il DoS a circa 3,3x rispetto a t=3. Un server malevolo può comunque servire un bundle manomesso (§12.4), quindi B non aggiunge un rischio nuovo, ma neanche un vantaggio di sicurezza.
      - Costo: un campo nuovo nella risposta di `GET /keyring` con stato NONE, parsing e validazione della env sul BE, un validatore sul FE e test nuovi. In più serve comunque `pm2 restart` (dotenv si legge al boot). Tutto per evitare al massimo un ciclo di deploy di circa 30 min.
21. **Controllo del ruolo del bench solo client:** un non-SUPERADMIN può caricare il chunk lazy (precachato da `globPatterns`, `vite.config.ts:62`), ma non trova segreti e la pagina non scrive dati né chiama API. Rischio accettato. iOS può limitare i Worker in background: la misura si fa con lo schermo attivo.
22. **`GET /notes?all=1` senza tetto.** Emerso dalla review di T0 (red-team, MAJOR) e accettato dall'utente il 21/10.
   - La lista contiene `searchText`, il testo in chiaro. Serve alla ricerca offline (`useNotes.ts:48`) e all'anteprima (`NoteList.tsx:86`).
   - `content` non ha limite di lunghezza fino a T2 (D10: 2 MiB).
   - Un utente invitato malintenzionato, con migliaia di note grandi, può esaurire la memoria del processo Node con una sola pull.
   - È il comportamento di prima di 73ae89a. L'app è solo su invito e in prod nessun utente supera le 50 note (21/10).
   - Un tetto di righe che tronca la risposta è vietato: le righe mancanti verrebbero cancellate dalla pull (`syncService.ts:166-171`).
   - Backlog: pull incrementale per `updatedAt`.
23. **Timeout di 30 s della pull (`api.ts`).** Emerso dalla review di T0 (red-team, MINOR), accettato.
   - Con una lista molto pesante su rete lenta la pull va sempre in timeout. Non cancella nulla (il catch salta la transazione), ma quel dispositivo smette di aggiornare le note.
   - Con meno di 50 note per utente non succede. Si riapre insieme alla pull incrementale.

---

## 13. Decisioni utente richieste

> **Esito (21/10, decisioni dell'utente):**
> - **D1, D2, D3, D5, D6, D7, D8, D9, D10, D11: accettate come raccomandato** qui sotto.
> - **D12: T0 dentro P2, niente hotfix 1.13.4.** La query del runbook (`HAVING count(*) > 50`) lanciata in prod il 21/10 non ha restituito righe.
> - **D2:** accettata. Finestra in cui il vault legacy non si apre (né online né offline): dal deploy (passo 4) all'apertura del canary, stima 2-4 h, al massimo 1 giorno lavorativo. Riguarda solo l'account dell'utente (l'unico legacy in prod, lo stesso SUPERADMIN del canary, confermato 21/10): nessun avviso ad altri utenti.
> - **D4:** `m=64 MiB`, `p=1`. Dispositivo di riferimento: **iPhone 12 o più recente** (A14+). `t` = il massimo che rispetta ENTRAMBI i vincoli, in Safari E nella PWA installata: p95 a caldo ≤ 1,5 s (20 campioni) E sblocco a freddo ≤ 2 s (3 campioni, ciascuno con Worker appena ricreato, si prende il peggiore). Minimo 3; se t=3 non li rispetta → ramo STOP del runbook (passo 7). `t` si fissa dopo la misura.
> - **D13:** rotta di benchmark solo SUPERADMIN nel rilascio P2, misurata in prod con `VAULT_SETUP_USERS` vuoto prima del canary; variante mkcert scartata; secondo deploy solo se t≠3 (Opzione A: `DEFAULT_KDF` costante nel bundle); Opzione B (default dal server) respinta. Emendamento applicato il 21/10 (revisione 4).

1. **D1: rotazione di VK fuori da P2.** Raccomandazione: **sì** (serve un sub-design: ri-cifratura per epoch, item `stale` in coda, versioni, escrow). Conseguenza: rischio 3.
2. **D2: canary con `VAULT_SETUP_USERS`.** Raccomandazione: **sì**. Durante il canary gli altri utenti legacy **non possono aprire il vault** (il bundle nuovo non ha lo sblocco legacy) e chi non ha un vault non può crearlo. In prod il legacy è di un solo account: finestra di 2-4 h, al massimo 1 giorno lavorativo (esito 21/10: solo l'account dell'utente, lo stesso SUPERADMIN del canary).
3. **D3: note vault legacy con allegati:** migrare il corpo e segnalare. Raccomandazione: **sì**.
4. **D4: parametri Argon2id** dopo il benchmark in prod: `m=64 MiB`, `p=1`, `t` = il massimo con p95 a caldo ≤ 1,5 s (20 campioni) e sblocco a freddo ≤ 2 s (3 campioni, il peggiore), sull'iPhone di riferimento (iPhone 12 o più recente, A14+), in Safari e nella PWA (minimo 3). **Serve la misura.**
5. **D5: P2 senza reset né recupero.** Raccomandazione: **sì**, con avviso.
6. **D6: rollback dopo il primo keyring = forward-fix**, SQL o `pg_dump`. **Accettare.**
7. **D7: spostamento dentro e fuori solo online**, con chiamata diretta. **Sì.**
8. **D8: titoli mai decifrati in Dexie;** promemoria con etichetta generica. **Sì.**
9. **D9: PDF del Kit a mano.** **Sì.**
10. **D10: `bodyLimit` di 3 MiB + `content` al massimo 2 MiB.** **Sì.**
11. **D11: job admin e banner di sollecito rimandati.** **Sì.**
12. **D12: T0 (pull completa).** Storico: proposto come hotfix 1.13.4 se la query del passo 2 avesse trovato utenti oltre 50 note. **Esito (21/10):** 0 righe, quindi T0 dentro P2, nessun hotfix.
13. **D13: metodo del benchmark iOS.** Storico: la raccomandazione era https locale con CA mkcert (scartata). **Scelta dell'utente (21/10):** rotta di benchmark solo SUPERADMIN nel rilascio P2, misurata in prod con `VAULT_SETUP_USERS` vuoto prima del canary. Costa un secondo deploy solo se t≠3 (§12.20).

---

## Appendice A: Finding respinti (anche solo in parte)

| Finding | Decisione | Motivo |
|---|---|---|
| RT-H1: VaultNoteEditor con `useLiveQuery` che tratta il cambio di `vaultBaseHash` come conflitto | **Respinto in parte.** Adottato solo il registro `openVaultNoteIds` (il reconcile salta gli id aperti) | Se il reconcile non tocca la riga aperta, `vaultBaseHash` cambia solo per i salvataggi dell'editor stesso. Il salvataggio usa il vecchio hash → la CAS del server (`note.service.ts:394`) dà 422 `conflict` → copia. Un secondo meccanismo client duplicherebbe la CAS |
| RT-M (T2): "flush → rilettura → `$transaction` senza altri await in mezzo" | **Respinto in parte** | Fra la rilettura e la tx restano gli await di `:229-256` e `:265`. Toglierli significa riordinare il percorso caldo 1.13.3. La finestra la chiude la CAS di `:394` con il `content` riletto, e il piano lo rende vincolante (§4.2) |
| RT-M (T6) | Adottato in variante (D13) | Nessuno staging: la misura avviene sul deploy P2 vero, con l'apertura chiusa dal kill switch |
| R-M (Workbox): check e2e sulla Cache Storage | **Sostituito** con il test del predicato serializzato di T12 (`new Function` + `grep dist/sw.js`) + verifica manuale 5 | In `localhost:5173` (dev) il SW di regola non è registrato: un e2e passerebbe a vuoto |

## Appendice B: Tracciabilità review

| ID | Sev. | Finding (sintesi) | Modifica |
|---|---|---|---|
| R-B1 | BLOCKER | Guardia di push senza keyring: passo 0 bloccato, titolo perso | §5.0 `isV3Active`; §5.7 punti 3-8 condizionati; §6.0; T14 (i) |
| R-M1 / RT-H3 | MAJOR | Titoli da `GET /notes` (limite 50) | T1 `title` in `itemSelect`; §6.2; T20; e2e con 60 filler |
| R-M1 (pull) | MAJOR | Pull limitata a 50 + `bulkDelete` | T0 (`?all=1`), §4.0, D12, §12.16/18 |
| R-M2 | MAJOR | Cache Workbox di keyring e note | §5.5 (predicato inline), T12 (test del predicato serializzato, `purgeApiCache`), §5.3, verifica manuale 5, Appendice A |
| R-M3 | MAJOR | Lock all'unmount: Kit mai disponibile in Settings | Deviazione §1; sheet in `VaultPage` (T22); e2e `vault-kit` dallo sheet |
| R-M4 | MAJOR | Regressione funzionale di VaultNoteEditor | §5.6 controlli portati; T18 test |
| R-M5 / RT-H2 | MAJOR/HIGH | NoteEditor resta montato o il debounce scrive plaintext dopo lo spostamento | §5.9 passi 1 e 7 (`movingRef`, flush, `setSelectedNoteId(null)`); T21a guardie in `noteService`; `noteService` tolto dai "Non toccati" |
| R-M6 | MAJOR | T11 rompe `tsc` | T11 additivo con `@deprecated`; T24b rimozione |
| R-M7 | MAJOR | Formato di `escrowHash` non definito | §3 "Hash"; §4.1; vettore condiviso T1/T13 |
| R-m1 | MINOR | Kit mostrato prima del commit | §5.4: PUT prima, poi cerimonia; marker; testo "rigeneralo"; §12.17 |
| R-m2 | MINOR | Concorrenze manuali prima di T25 | §10: dopo T25 |
| R-m3 | MINOR | Test del kill switch senza root key | T1 in `vault.keyring.test.ts` |
| R-m4 | MINOR | KAT e NFC in T5 | `argon2Raw` + stringa NFD (T5, §5.1) |
| R-m5 | MINOR | CREDENTIAL `''`/JSON in chiaro non classificate | §6.3; T20 |
| R-m6 | MINOR | Spostamento con NONE non definito | §5.9 passo 0; T21 |
| R-m7 / RT-M (T2) | MINOR/MEDIUM | `flushLiveDoc` che lancia; invariante; import lazy | §4.2 (solo con `guard`, try/catch, import statico); §1 invariante; Appendice A |
| R-m8 | MINOR | Regola `synced` contraddittoria | §5.7.5; T14 (d) |
| R-m9 | MINOR | HANDOFF §3.2 senza task | §1 fuori perimetro; §12.15 |
| R-N1 | NIT | Test 2,5 MiB impossibile | T2: `content` 2 MiB + altri campi |
| RT-H1 | HIGH | Reconcile vs editor aperto: edit perso | §5.8.1 `openVaultNoteIds`; T15, T18; e2e `vault-conflict` "editor aperto"; Appendice A |
| RT-M1 | MEDIUM | Item solo-titolo dei bundle vecchi | §5.8.3; §5.7.8; T15 |
| RT-M2 | MEDIUM | Item oltre 2 MiB irraggiungibili | §5.6 sola lettura + "Togli dal vault"; §6.5; §12.7 |
| RT-M3 | MEDIUM | `authKey` nel pending del PIN | §5.1, §5.4: pending `{rev, wrappedVkPinHash}`; T13 |
| RT-M4 | MEDIUM | Lock con salvataggio pendente | §5.2 `registerPreLock`, `touchVault`; T11, T18 |
| RT-M5 | MEDIUM | Benchmark su http non sicuro | T6 controllo `isSecureContext`/`crypto.subtle` + https di prod; §10 manuale 1; D13 |
| RT-M6 | MEDIUM | Wording di D2 ("sola lettura") | §5.3, D2, runbook §11.9, T17 |
| RT-1 | vincolo di processo | T25 rimuove il lock P1 (`VAULT_ROOT_KEYS` non vuota): da quel commit un keyring READY è possibile, quindi T25 si unisce a `main` solo insieme a tutto P2 (branch `feat/vault-p2`), P1:446-449/:536 e addendum T10 #5 | §8 branch `feat/vault-p2`; T25 |

## Appendice C: emendamento D13/D4 (21/10)

Revisione 4. Fonte: decisioni dell'utente del 21/10 più l'emendamento dell'architect, con le correzioni F1-F17 che prevalgono dove lo contraddicono.

| ID | Correzione | Dove applicata |
|---|---|---|
| F1 | Runbook passo 1: "D4 chiuso" diventa "T6 verde; D4 si chiude al passo 6 (misura in prod)" | §11 passo 1 |
| F2 | Se t>3, nello stesso commit di `DEFAULT_KDF.t` si cambia il solo valore di `KDF_T_MIN` (costante esportata da `vault.service.ts`, usata dai DUE schemi: `routes/vault.ts:16` e `vault.service.ts:281`); test del keyring con la costante; un bundle vecchio con t=3 riceve 400 (rivista in G1) | §3 (Argon2id), T1, §11 passo 7, §8 |
| F3 | Dopo rifiuto o timeout: `worker.terminate()` e ricreazione lazy; test prima chiamata fallita / seconda riuscita; `resetArgon2Worker()` esportata e chiamata prima di ogni campione a freddo (G2); tolto il rischio "riuso del Worker ignoto" | §5.1, T5, Dettaglio T6 |
| F4 | Vecchi passi 8-9 del runbook diventano 10-11; "Fra i passi 4 e 7" diventa "4 e 9"; RT-M6 punta a §11.9 (apertura) | §11, Appendice B |
| F5 | `Argon2Bench` tolto; il file è `features/admin/VaultBenchPage.tsx` | §8, T6 |
| F6 | Il nuovo wrap del cambio PIN usa `DEFAULT_KDF`; test in T13 | §5.4, T13 |
| F7 | Accettazione 10: al setup i parametri vengono da `DEFAULT_KDF`; allo sblocco arrivano dal server e li proteggono il controllo client di §3 più `kdfCanon` nell'AAD | Elenco accettazioni (intestazione) |
| F8 | Opzione B respinta senza l'argomento "rompe `vault.keyring.test.ts:220`" (il test usa `toMatchObject`) | §12.20 |
| F9 | Sequenza t=3..10 crescente, stop al primo t che viola un vincolo D4 (caldo p95 ≤ 1,5 s E freddo ≤ 2 s, Safari e PWA) | §13 D4, §10 manuale 1, Dettaglio T6 |
| F10 | D2: finestra 2-4 h, massimo 1 giorno lavorativo, solo l'account dell'utente. Tolti i residui di D12 (§8 hotfix, `v1.13.4..HEAD`); §12.18 chiusa con l'esito del 21/10 | §11 (Finestra), §13 D2/D12, §8, §12.18 |
| F11 | Il JSON del bench contiene `DEFAULT_KDF` e l'entry `index-*.js`; smoke del passo 7: `DEFAULT_KDF.t` = t scelto e nuova entry | Dettaglio T6, §11 passo 7 |
| F12 | Passo 8, prima del setup: hard reload sul dispositivo del canary, bench aperto, `DEFAULT_KDF.t` ed entry uguali al pacchetto | §11 passo 8 |
| F13 | Output incrementale (almeno per ogni t), t crescente, pulsante Stop; screenshot dopo ogni t su iOS | Dettaglio T6, §10 manuale 1 |
| F14 | `ts1` di `_backup_<ts1>` al passo 4; rollback pre-P2 sempre `_backup_<ts1>`; SHA256 ed entry di ogni pacchetto nell'addendum D4; tag solo sul pacchetto finale | §11 passi 4 e 7, Rollback |
| F15 | Rotta `admin/vault-bench` fuori da `<AppLayout/>` (`App.tsx:89`); guard: nessun utente → `/login`, non SUPERADMIN → `/notes` | T6, §8, criteri vitest |
| F16 | Ruolo SUPERADMIN (enum `USER\|SUPERADMIN`), mai ADMIN, sul bench | Dettaglio T6, §10, §11, §13 |
| F17 | Riquadro "Esito": riga D4 (vincolo a freddo), riga D13 ("emendamento applicato il 21/10, revisione 4"), nuova riga D2 | §13 |
| G1 | MAJOR (round 2, 21/10): Il pavimento di `t` vive in due schemi (`routes/vault.ts:16`, `vault.service.ts:281`): costante `KDF_T_MIN` in T1, test 400 su POST e PUT | §3, §8, T1, §11 passo 7, F2 |
| G2 | MAJOR (round 2): `resetArgon2Worker()` esportata, test di ricreazione, chiamata prima dei campioni a freddo, criterio vitest | §5.1, T5, Dettaglio T6, F3 |
| G3 | MINOR (round 2): Formula del 400 con ricarica sostituita: setup o cambio PIN non avvengono, `errors.vault.invalidPayload` (elencata in §7 riga 31, T10, T24, ma oggi NON presente in `frontend/src/locales/en.json` e `it.json`: va aggiunta in T24, coperta da `i18nVaultKeys.test.ts`), serve hard reload | §3 |
| G4 | MINOR (round 2): Riga RT-1 rimessa nell'Appendice B dopo RT-M6; Appendice C dopo | Appendice B/C |
| G5 | MINOR (round 2): T13 solo test FE su `DEFAULT_KDF`; controllo BE del ramo t>3 come verifica esplicita nel runbook | T13, §11 passo 7 |
| G6 | NIT (round 2): Setup: su 400/403/503 il marker `pending{kind:'kit'}` si cancella subito; assert in T13 | §5.4, T13 |
| H1 | MINOR (round 3, 21/10, senza nuova review): T1 elenca anche `routes/vault.ts` (`:16`) e `__tests__/vault.service.test.ts` (`:286`) | T1 |
| H2 | NIT (round 3): ramo t>3 = cambiano nello stesso commit `DEFAULT_KDF.t` e `KDF_T_MIN` | §3 |
| H3 | MINOR (round 3): verifica 400 POST/PUT del runbook coperta dai test di T1, nessuna chiamata contro prod | §11 passo 7 |
| H4 | MINOR (round 3): criterio vitest dei campioni a freddo sull'ordine con `mock.invocationCallOrder` | Dettaglio T6 |
| H5 | MINOR (round 3): reset/terminate rifiutano subito le richieste pendenti con `kdfFailed`; il timer termina solo la propria istanza; test in volo + reset | §5.1, T5 |
| H6 | MINOR (round 3): `errors.vault.invalidPayload` assente dai locali, si aggiunge in T24 | §3, T24, G3 |
| H7 | NIT (round 3): yield 250 ms dopo il reset, un retry per campione a freddo, campo `retries` nel JSON | Dettaglio T6 |

## Addendum dopo la review di T0 (21/10)

- **Reviewer: OK.** Ha segnalato un MINOR, già corretto: il test della fetch fallita non aveva righe locali da cancellare. Ora rifiutano entrambe le GET (note proprie e condivise) e c'è una riga `synced` locale, quindi il test fallisce se una GET rifiutata venisse trattata come lista vuota.
- **Red-team:** ha segnalato un MAJOR (DoS di `all=1` senza tetto) e un MINOR (timeout di 30 s). L'utente li ha accettati come residui, vedi §12.22 e §12.23.
- **Correzione respinta:** `take: 5000` con `all`. Riaprirebbe il troncamento che T0 chiude.

## Addendum dopo la review di T1-T4 (21/10)

Commit: T1 `95c1814`, T3 `31a097f`, T4 `3591b99`, T2 nel commit seguente. Ogni task ha avuto reviewer e red-team, più un secondo giro mirato dove servivano correzioni.

**Decisioni che cambiano il piano (T2), approvate dall'utente**
- **Fail closed sul flush.** Se `flushLiveDoc` fallisce, l'ingresso nel vault risponde 422 `errors.vault.conflict`, senza rilettura né scrittura, e il client ritenta. Il piano diceva "si prosegue (CAS)". Così però le modifiche non salvate del doc live si perdevano in silenzio, perché la CAS confronta il DB e non la memoria.
- **`hocuspocus.ts` (TIER 1).** `flushLiveDoc` apre la connessione con `{ restore: true, flush: true, flushFailed: false }`.
  - Nei due catch di `store()`, con `flush` attivo, si imposta `context.flushFailed = true`, e `flushLiveDoc` lancia dopo il disconnect.
  - `store()` non deve mai lanciare. Nel debouncer di Hocuspocus 3.4.4 (`useDebounce`), una run rifiutata lascia una voce in `runningExecutions`: ogni store successivo dello stesso doc fallirebbe, oppure produrrebbe un unhandled rejection. Il backend non ha un handler per gli unhandled rejection.
  - Una prima versione rilanciava da `store()`: scartata per questo motivo.
  - I salti voluti di `store()` non impostano il flag: nota vault, doc degenere, guardia del contenuto vuoto, `count 0`.
  - Il restore della 1.13.2 non cambia: la route intercetta l'errore di `flushLiveDoc` e prosegue, con un warn in più.
- **`searchText` delle CREDENTIAL.** All'update diventa `null` (prima veniva solo saltato il ricalcolo), coerente con `createNote`. Le righe esistenti che hanno già un `searchText` di una CREDENTIAL si puliscono solo con una scrittura in prod, da decidere col runbook. Query di verifica: `SELECT count(*) FROM "Note" WHERE "noteType"='CREDENTIAL' AND "searchText" IS NOT NULL;`.

**Correzioni nate dalla review**
- T1: il test del pavimento su POST passava anche senza pavimento, perché `assertP256` rifiutava prima un `vkSigPub` finto. È stato spostato in `vault.route.test.ts`, con `keyringBody` e un controllo positivo.
- T3: aggiunto il test della CAS sul contenuto riletto dopo `beforeRestore`.
- T4: V1 ora ha input letterali, SPKI e x/y. Aggiunti:
  - un test di apertura indipendente, con stringhe AAD e info letterali;
  - `diffieHellman` su `KeyObject`, senza esportare la scalare privata;
  - input `Uint8Array`, cioè le colonne `Bytes` di Prisma;
  - la validazione di epoch, id (anche senza il carattere separatore), `sRoot`, iv e sealed;
  - iniezione consentita solo con `NODE_ENV=test`, perché in prod pm2 non imposta `NODE_ENV`;
  - errori `errors.vault.invalidSealInput` e `errors.vault.invalidSeal`.

**Residui accettati**
- T2:
  - `content` ha il massimo di 2 MiB contato in caratteri UTF-16, mentre `bodyLimit` conta i byte. Un contenuto non ASCII molto grande dà 413 invece di 400. Gli envelope sono ASCII, e il limite resta più largo di prima (1 MiB globale).
  - Le modifiche che arrivano fra il flush e `closeConnections` si perdono (decine di ms). È preesistente in P1, accettato come in `replaceLiveDocContent`.
  - Se il flush fallisce, il debouncer ha già cancellato il timer pendente del client. Le modifiche degli ultimi 2 s restano solo nel doc Yjs del client finché non si riconnette. Succede solo con il DB in errore. Backlog: riprogrammare uno store debounced quando `flushFailed` è vero (TIER 1).
  - Il flush dell'ingresso nel vault usa `restore: true` e quindi salta lo snapshot del contenuto pre-flush. Dalla cronologia sparisce una versione intermedia, non il contenuto.
  - Una WS che finisce di caricare il doc dopo `closeConnections` resta aperta su una nota ormai vault, e i suoi salvataggi vengono scartati da `store()`. È preesistente. Backlog: ricontrollare `isVault` al caricamento.
  - La route `PUT /share/notes/:noteId/content` resta a 1 MiB senza `max`, e `title` non ha `max`. Backlog.
- T3: con il 409 della CAS lo snapshot forzato è già scritto: resta una versione in più, nessuna perdita. Stesso comportamento del 409 sul cambio di vault.
- T1: il 503 `setupDisabled` non scrive un evento di audit.
- Frontend (da coprire in T23/T24): mancano in `en.json`/`it.json` le chiavi `errors.vault.setupDisabled`, `errors.vault.plaintextRequired` e `errors.vault.invalidPayload`. Inoltre il 409 `restoreConflict` va mappato in `VersionHistoryModal.tsx`.

**Da fare in P4, quando si userà `vaultSeal`:**
- controllare il tipo di `userId`/`rootKeyId`;
- validare `rootPrivateKey`, che deve essere un `KeyObject` privato `secp384r1` oppure PKCS#8, altrimenti `invalidSealInput`;
- aggiungere test sul materiale di chiave non valido.

## Addendum dopo la review di T5-T12 (21/10)

Commit: T5 `ef2b841`, T7 `1e7ad11` (più un follow-up), T8 `4cccc2a`, T10 `64c0914`, parte vite di T12 `32c7453`, T6 `e438df5`, `no-store` sulle risposte vault `b2668e1`, T9 `3c990e1`. T11 e T12 (TIER, diff approvati dall'utente in due versioni) sono nel commit seguente.

**Decisioni che cambiano il piano**
- **Cache Workbox (§5.5).** Il predicato esclude tutto `/api/notes/` (e non solo `/api/notes/:id`) oltre a `/api/vault/`. `GET /api/notes/:id/versions` restituisce il content di ogni versione, comprese quelle in chiaro delle note vault legacy. La lista `/api/notes` resta in cache. All'avvio, una volta per versione dell'app, `main.tsx` chiama `purgeApiCache()`: le voci salvate dal SW precedente (keyring, note in chiaro) non restano per 24 h.
- **`lib/apiCache.ts`.** Modulo senza import con `purgeApiCache` e `purgeVaultCache`, usato da `vaultApi.ts`, `authStore.ts` e `main.tsx` (niente cicli con `api.ts`).
- **`Cache-Control: no-store`** su tutte le risposte `/api/vault/*`, con un hook `onSend` in `routes/vault.ts`. Non va inviato come header di richiesta: non è CORS-safelisted, e in dev l'API è cross-origin.
- **`vaultStore` (T11).**
  - `lockVault()` restituisce `Promise<void>`. Lo stato si azzera in modo sincrono, poi `Promise.allSettled` sui flusher, con gli errori loggati.
  - `unlock()` con un vault già sbloccato blocca prima, così i flusher cifrano con le chiavi vecchie.
  - `setKeyringCache` salva solo i campi di `VaultUserCache` e scarta `wrappedVkPin` con offline OFF.
  - Listener `storage`: rehydrate su `vault-storage`, lock quando il token di `auth-storage` sparisce (logout in un'altra scheda).
- **`logout` (T12).** Prima `lockVault()`, poi via token e utente, poi `clearLegacy`, `purgeApiCache`, `queryClient.clear()`.
- **Vincolo per T18.** Il flusher pre-lock di `VaultNoteEditor` scrive l'envelope in locale (Dexie + syncQueue), mai via REST: al logout il token non c'è più.
- **`vaultCrypto` (T7).**
  - Un solo validatore per ogni costruttore di AAD o info: epoch intero 0..999999999; userId, noteId, noteType e rootKeyId non vuoti e senza separatore. Il contratto degli errori resta di 4 codici.
  - La chiave HKDF di VK ha solo `deriveKey`: con `deriveBits` un attaccante con XSS avrebbe potuto esportare i byte di `K_note`. Resta il limite di `deriveKey` con `extractable`.
  - V2 è prodotto e verificato dal `sealRootShare` del frontend, con lo sha256 incrociato sui due letterali.
- **`argon2` (T5).** Un solo helper `rawArgon2` in `argon2Core.ts`, usato sia dal Worker sia dal fallback: il KAT copre il codice del Worker. `deriveS` accetta solo un `Uint8Array` di 16 B.
- **Policy del PIN (T9).** Blocklist con i prefissi di 4-5 lettere delle parole lunghe. In più rifiuta:
  - una parola in qualunque posizione;
  - un carattere ripetuto 3 o più volte;
  - blocchi ripetuti, anche non adiacenti;
  - 3 o meno caratteri distinti;
  - righe e colonne di tastiera, anche intercalate a cifre;
  - nomi di 3 lettere;
  - nomi con accenti, normalizzati prima del confronto.
  Chiusa dopo 2 round di red-team per decisione dell'utente: è una difesa in profondità.

**Finding respinto**
- T12 vite, red-team MAJOR: `/api/share/notes/accepted` e `/api/search` in `api-cache` con testo in chiaro. Sono note non vault, già in chiaro in IndexedDB per l'offline (design dell'app). L'invariante del piano riguarda il testo in chiaro del vault, e le note vault non si condividono.

**Residui accettati**
- Lista `/api/notes` in cache con titoli e `searchText` delle note vault legacy, fino alla migrazione. Si chiude con `/vault/migrate`.
- Il PDF del Kit usa Helvetica/Courier WinAnsi: i caratteri fuori Latin-1 diventano `?`.
- Il test di App per il bench non ha un controllo positivo (una route dentro `AppLayout` che faccia partire il sync).
- I flusher pre-lock al logout causato da un 401 non hanno più il token: per questo il vincolo su T18 (scrittura locale).

**Da fare in T16 (Kit):** tenere il Kit solo nello stato del componente, `URL.revokeObjectURL` del PDF alla chiusura, mai in Dexie, localStorage o log, `fill(0)` del `Uint8Array` dopo l'uso.

**Chiavi i18n da aggiungere in T24** (en.json e it.json, coperte da `i18nVaultKeys.test.ts`; l'ambito del test va esteso alle `errors.common.*`):
- `errors.vault.setupDisabled`, `errors.vault.plaintextRequired`, `errors.vault.invalidPayload`, `errors.vault.rateLimited`, `errors.vault.unavailable`, `errors.vault.locked`;
- `errors.common.networkError`, `errors.common.unknownError`;
- `vault.kit.errors.invalidLength`, `vault.kit.errors.invalidChar`, `vault.kit.errors.checksum`, `vault.kit.errors.pdfOverflow`;
- `vault.pinPolicy.format`, `.date`, `.sequence`, `.repetition`, `.common`, `.personal`;
- inoltre il 409 `restoreConflict` va mappato in `VersionHistoryModal.tsx` (T23).
- **T11, terzo giro del red-team (OK).** Il flusher riceve il contesto catturato `{ keys, userId, epoch }` e non deve leggere `userId`/`epoch` dagli store (vincolo per T18). Dopo il rehydrate da un'altra scheda il vault si blocca se `byUser[unlockedUserId]` manca, non è `READY` o ha un epoch diverso. Anche `localStorage.clear()` (evento `storage` con `key` null) blocca.
- **Backlog per T13 (`vaultSession`), MINOR.** Un cambio utente senza logout (`/login` → `setAuth(u2)`, anche in un'altra scheda) lascia sbloccato il vault di u1. Nessuna chiave viene usata per u2: `getKeysFor` fallisce chiuso e la sync filtra per `userId`. Da fare: in `setAuth` e nel listener `auth-storage`, `lockVault()` se `unlockedUserId` è diverso dal nuovo utente (tocca `authStore.ts`, TIER 2).
- **Residui accettati (NIT).**
  - `removeItem('vault-storage')` in un'altra scheda non blocca: nessun codice lo fa, e `clear()` è già coperto.
  - Durante il rollout una scheda col bundle pre-v3 riscrive `vault-storage` senza `byUser`. Al reload successivo lo sblocco offline richiede di nuovo la rete.

## Addendum dopo T13, T21a e T14 (22/10)

Commit: T13 `4a0ae78`, T21a `c2a1ee9`; T14 e la CAS idempotente sono nei commit seguenti.

**T13 (`lib/vaultSession.ts`, `lib/deviceKeyStore.ts`)**
- `setup` e `regenerateKit` ricevono `rootKey: {id, ecdhSpki}`: la UI (T16/T22) lo passerà quando esiste `utils/vaultRootKeys.ts` (T25).
- `shares[userId]` contiene anche `wrappedVkSigKey`, cifrato sotto VK, necessario allo sblocco offline.
- `changePin` e `regenerateKit` chiedono il PIN attuale: servono i byte grezzi di VK.
- Marker `pending` in due slot separati, `userId:kit` e `userId:pin`: il cambio PIN non cancella il promemoria del Kit.
- Cambio utente, nella stessa scheda (subscribe ad `authStore`) o in un'altra (listener `storage`): `lockVault` se l'utente sbloccato è diverso.
- `removeFromDevice` copre solo la sessione. Il rifiuto con item pending/failed e la cancellazione delle righe Dexie restano a T22.

**T21a.** Transitorio voluto: finché non arrivano T17/T18/T19/T21, le guardie di `noteService` rifiutano i vecchi percorsi vault (`NoteEditor` su riga vault, `CredentialForm`, creazione da `VaultPage`). In questo intervallo gli E2E del vault sul branch possono fallire. Il branch non è rilasciabile prima di P2 completo (T25).

**T14 (`syncService.ts` e `db.ts`, TIER 1, diff approvati)**
- In `db.ts` solo i tipi `vaultBaseHash?` e `vaultSentHash?`; nessuna versione Dexie (`version(` = 15).
- `vaultSentHash` è l'hash dell'envelope inviato. Viene scritto sulla riga **prima** della PUT, senza toccare `updatedAt` né `syncStatus`, e la pull lo preserva.
- **CAS idempotente sul server** (`assertVaultContent`): un contenuto identico a quello corrente è un replay, quindi successo anche con `baseHash` vecchio. I controlli `notReady`/`plaintextRejected`/`stale` restano prima.

**Obblighi per T15 (nati dalla review di T14)**
- **`vault:conflict` dopo una risposta persa** (PUT v1 applicata, risposta persa, l'utente scrive v2, retry con la base di v0).
  - Prima di creare la copia, leggere il contenuto del server. Se `sha256(server) === row.vaultSentHash`, non è un conflitto: `vaultBaseHash = sha256(server)`, item di nuovo pending, nessuna copia.
  - Test: nessuna copia nel caso risposta persa più modifiche; copia nel caso di vero conflitto.
- **Item bloccati per sempre su `vault:stale`/`vault:notReady`** (reset da un altro dispositivo, `RESET_PENDING`).
  - Il push blocca gli item successivi e il retry li salta, ma 5.8 risolve solo conflict e forma legacy. Il reconcile deve togliere o riattivare gli item `vault:stale`/`vault:notReady` di una nota quando la riga è cifrata con l'epoch corrente del keyring.
  - Con keyring non READY li lascia.
  - Test: `vault:stale` fallito più riga ricifrata, poi la push parte.

**Residui accettati (T14)**
- **CREATE con P2002 e risposta del server diversa dall'inviato** (un altro dispositivo ha modificato la nota fra il primo POST e il retry): `vaultBaseHash = sha256(server)` e la riga resta con il contenuto locale. È la scelta del piano: l'alternativa romperebbe il caso comune «risposta persa + modifica locale».
- **Titolo in chiaro inviato da un item legacy senza `content`** (UPDATE `{title, isPinned}` di un bundle pre-P2) con keyring READY. Il server lo rifiuta e non lo salva. Il passo 0 della migrazione svuota la coda prima del keyring, quindi può capitare solo con una scheda col bundle vecchio dopo la migrazione.

**Chiavi i18n nuove per T24:** `errors.vault.kitNotUpdated`, `errors.vault.offlineUnavailable`, `errors.vault.notReady`, `errors.vault.invalidPin`.

## Addendum D4 — rilascio 1.14.0 (28/10/2026)

- Release e tag `v1.14.0`: `aafca4c`, su `main` e `origin/main`.
- Pacchetto primo deploy: `notiq-v1.14.0-full-20261028_171355.zip`.
- SHA256: `A25889A858F02F9EFB142DA4BCE0C7B42FC018BC17FA3818CFD656FC9429206F`.
- Entry frontend: `/assets/index-CXMfL_xE.js`.
- `frontend/dist/sw.js`: 1 riferimento a `/api/vault/`; nessuna occorrenza di `rk_e434f78b8f179ab3` nei sorgenti.
- Esiti locali finali: E2E 70/70, unit frontend 1193/1193, typecheck e build verdi; lint `src + e2e` 0 errori con 51 warning preesistenti.
- Benchmark iOS, scelta finale di `t`, timestamp `ts1`, dump del canary ed esiti prod: da annotare qui durante il runbook.
