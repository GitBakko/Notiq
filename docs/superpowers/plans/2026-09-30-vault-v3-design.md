# Vault v3: design finale (cifratura reale, multi-dispositivo, recupero in doppio controllo, reset reale)

Il design di partenza è **security-first**: è l'unico senza finding fatali. Dagli altri due prendo l'hotfix P0, la cifratura dei titoli fin da subito e le guardie su sharing, search e AI. Ho rivisto nel codice le correzioni che dipendono da dettagli concreti:
- la CSP permette già il WASM (`app.ts:63` `'wasm-unsafe-eval'`);
- la coda di sync non unisce gli UPDATE, li spinge come snapshot (`syncService.ts:771`) e li riordina (`:755` `hasQueuedReferenceCreate`);
- `updateSharedNoteContent` (`sharing.service.ts:~850-866`) e `hocuspocus.ts` `store()` (`:413-428`) scrivono `Note.content` senza passare da `note.service`;
- `Notification` è per utente, non per sessione (`schema.prisma:262`): per recapitare qualcosa a un solo dispositivo va cifrato per quel dispositivo (§3.2).

> Aggiornato il 2026-09-30 con le decisioni finali dell'utente (§10): PIN alfanumerico di 6 caratteri al posto della password di 10, recupero interamente informatizzato (niente telefono, carta, USB o macchina air-gapped).

---

## 1. Sintesi

- Il vault funziona su **tutti i dispositivi**. Il dispositivo 2 chiede il PIN del vault, non lo crea da capo. Il logout blocca il vault ma non lo cancella.
- Note, **titoli** e credenziali sono **cifrati nel browser** con AES-256-GCM. Il server vede solo ciphertext e chiavi incapsulate.
- Il segreto del vault resta un **PIN di 6 caratteri**, ma **alfanumerico e case-sensitive**, con almeno 1 lettera e 1 cifra (solo cifre rifiutato). Lo proteggono Argon2id 64 MiB, pepper + `serverShare` lato server e il lockout online dopo 6 errori. Onestà: con DB + pepper, o con un dispositivo rubato che ha la cache offline, il brute force costa **al massimo ~1,2 GPU-anni, in media ~7 mesi, e giorni per i PIN scelti da persone** (§2.4). Non è inattaccabile: è il rischio residuo principale.
- **Limite dichiarato del requisito "root mai da solo":** vale per la **procedura di recupero**, non in assoluto. Chi gestisce il server ha DB + pepper, e con quelli arriva **prima o poi** al PIN con un brute force offline (§2.4). Inoltre può servire un bundle JS modificato e catturare PIN e Kit (§9.1). Un PIN di 6 caratteri in una web app non chiude nessuno dei due casi. La UI del setup lo dice in chiaro (§3.5.5).
- Lo sblocco funziona **offline** sui dispositivi già usati online, attivo di default e disattivabile per dispositivo. Creare il vault, cambiare PIN, reset e recupero richiedono la rete.
- Alla creazione del keyring l'utente riceve un **Recovery Kit** (32 caratteri Crockford + 2 di controllo), mostrato **una sola volta**, da scaricare in PDF o copiare. Si può rigenerare dalle impostazioni del vault finché si conosce il PIN.
- Il **recupero** è **interamente informatizzato** e in doppio controllo: richiesta in app → **approvazione di root** nel pannello admin → codice monouso in due metà (**notifica in-app al solo dispositivo richiedente** + **email**) → **72 ore** annullabili da ogni sessione → **rilascio di root con la root passphrase** → Kit + nuovo PIN + nuovo Kit. Con la procedura né root da solo né l'utente da solo con il Kit possono recuperare. Restano fuori i due limiti dichiarati sopra: brute force con DB + pepper e bundle manomesso.
- Il **reset** cancella davvero note, credenziali, tag, versioni e allegati del vault. Serve il codice generato dal sistema da digitare (stile GitHub) + la password dell'account. Si può annullare per 7 giorni.
- I vault esistenti in prod si migrano **nel browser al primo sblocco**. Nessun dato viene cancellato prima che il server abbia riletto e verificato il ciphertext.
- Il buco "contenuto vuoto sovrascrive il server" si chiude subito, con un hotfix P0 senza crittografia. Poi si chiude in modo definitivo con il compare-and-swap lato server.
- Se l'utente perde **sia il PIN sia il Kit**, il vault è irrecuperabile, per scelta di design. Resta solo il reset.
- Allegati e import sono bloccati nelle note vault; i nomi dei tag vault restano in chiaro sul server (documentato, §9).

---

## 2. Architettura chiavi e crittografia (parametri)

### 2.1 Gerarchia

```
PIN vault (6 char) ──Argon2id(pinSalt16, m=64MiB,t=3,p=1)──► S (32B)
S ──HKDF("notiq/vault/v3/auth|"+userId)──► authKey ──► server: authVerifier = HMAC(PEPPER, authKey)
S || serverShare(32B, rilasciato da POST /unlock) ──HKDF(salt=pinSalt, "notiq/vault/v3/kek|"+userId)──► KEK_pin
VK = 32B random (una per utente per epoch)
wrappedVkPin = AES-GCM(KEK_pin, VK, AAD="vk|userId|epoch|"+kdfParamsJSON)
vkSigKey = ECDSA P-256 generata nel client al setup (e a ogni rotazione di VK)
  ──► server: vkSigPub (SPKI, pubblica) + wrappedVkSigKey = AES-GCM(VK, PKCS#8, AAD="vksig|userId|epoch")
vkProof = ECDSA(vkSigKey, "notiq/vault/v3/proof|"+METHOD+" "+path+"|"+userId+"|"+epoch+"|"+rev+"|"+sha256(payload))
  (prova di possesso di VK; il server conserva solo la chiave pubblica, nessun segreto bearer transita mai)
K_note = HKDF(VK, salt=noteId, "notiq/vault/v3/note")
Escrow 2-di-2:
  S_root (32B) ── sealed to ROOT ECDH P-384 pub ──► sealedRootShare
  S_user (20B = Recovery Kit, 32 char Crockford + 2 check)
  RK = HKDF(S_root||S_user, "notiq/vault/v3/escrow|"+userId)
  escrowBlob = AES-GCM(RK, VK, AAD="escrow|userId|epoch|rootKeyId")
  userShareUnderVk = AES-GCM(VK, S_user)   (solo re-seal su rotazione root senza nuovo Kit; il Kit NON si ri-mostra)
Chiave root (ECDH + ECDSA P-384, PKCS#8):
  file sul server = AES-GCM(Argon2id(root passphrase, salt16, m=256MiB,t=3,p=1), {rootKeyId → PKCS#8, …})   (mai in chiaro su disco)
  (il file tiene TUTTE le coppie root ancora referenziate da almeno un keyring, §2.2 Root)
```

- Il cambio PIN re-incapsula solo VK. VK ed epoch non cambiano, quindi ciphertext e versioni restano validi.
- L'epoch cambia solo con il reset.
- La rigenerazione del Kit (vault sbloccato) genera **nuovi `S_root` e `S_user`**, sigilla il nuovo `S_root` alla chiave root pubblica e sostituisce escrow e `userShareUnderVk` con `PUT /vault/keyring` + `vkProof`. Il client non ha bisogno del vecchio `S_root`: è solo un segreto casuale. Il vecchio Kit smette di funzionare.
- **`vkProof` (definizione).** Ogni mutazione del keyring (`PUT /vault/keyring`, `POST /vault/recovery/:id/complete`) manda `{payload, vkProof}`: `payload` è la **stringa JSON esatta** che il server poi fa parsing (niente canonicalizzazione), `vkProof` è la firma ECDSA P-256 del messaggio in §2.1. Il server verifica con `vkSigPub` salvata, poi applica la CAS su `rev`. Siccome `rev` è nel messaggio firmato e la CAS lo incrementa, una richiesta catturata (log di proxy, ARR, root) **non si può rigiocare**: dopo il primo successo il `rev` non torna più. Metodo e path nel messaggio impediscono di spostare una firma da un endpoint all'altro. Il server non riceve **mai** un segreto riutilizzabile: niente `vkAuth` grezzo, neanche al setup (al setup viaggia solo `vkSigPub`). La rotazione di VK genera anche una nuova `vkSigKey`.

### 2.2 Scelte e parametri

| Elemento | Scelta | Motivo |
|---|---|---|
| KDF | **Argon2id** via `hash-wasm` (MIT, zero dipendenze), caricato in modo lazy nel chunk del vault e in un **Web Worker**. Parametri: m=65536 KiB, t=3, p=1, output 32B. Minimo imposto dal client e dallo Zod server: m≥65536, t≥3. | Contro un PIN a bassa entropia l'unica difesa significativa sulle GPU è la memory-hardness, e PBKDF2 sulle GPU costa poco. L'obiezione "serve cambiare la CSP" non vale più: la CSP è già in `app.ts:63`. Precedente: Bitwarden usa 64 MiB. Tempo e memoria su iOS vanno misurati in P2. `kdf` e `kdfParams` sono salvati, quindi si può calibrare senza downgrade. **Calibrazione verso l'alto (finding red team):** i parametri sono per keyring, e ogni dispositivo dell'utente deve derivare con gli **stessi** parametri. Per questo non si può scegliere "il massimo del dispositivo che fa il setup": un iPhone poi non sbloccherebbe (OOM). Il minimo resta quello deciso (§10.1). Il benchmark P2 decide due cose: `t` si alza finché lo sblocco su iOS resta sotto ~1,5 s (costa solo tempo, non memoria); m=128/256 MiB diventa il default **solo** se regge sulla PWA iOS, e in quel caso va riconfermato con l'utente, perché cambia la decisione §10.1. Con 256 MiB e t=4 il brute force costa circa 5 volte di più. |
| Pepper | `VAULT_PEPPER_KEY` (32B, env). Protegge `authVerifier` e `serverShareEnc` (la prova di possesso di VK è una firma: non serve pepper). Con `pepperKeyId` per la rotazione. | Un leak del **solo DB** (dump, backup) non permette il brute force offline. |
| Cifratura degli item | AES-256-GCM, IV random di 96 bit per ogni scrittura, chiave per nota `K_note`. | AEAD nativo in WebCrypto. |
| Envelope | `nv3.<epoch>.<b64url iv>.<b64url ct+tag>`. Plaintext: `{v:1,t:title,c:<TipTap JSON \| CredentialData>}`. AAD: `notiq/vault/v3/item\|userId\|noteId\|noteType\|epoch`. | Lega il ciphertext alla sua nota: il server non può scambiare blob o riportare un'epoch vecchia. Non esistono percorsi di "duplica nota" (verificato: niente in `notes.ts`/`note.service.ts`). |
| Titolo | Dentro l'envelope. Sul server `title=''`, `searchText=null`. | Cifratura dei titoli portata subito (finding dell'attacco su minimal-change). |
| Root | ECDH P-384 (seal) + ECDSA P-384 (firma), chiavi pubbliche **fissate nel bundle** in `frontend/src/utils/vaultRootKeys.ts` e anche nel backend per verificare la firma. Le private stanno **sul server** in un file cifrato con la **root passphrase** (Argon2id m=256 MiB + AES-256-GCM), fuori dal DB e dai backup ordinari; si decifrano solo in memoria al momento del rilascio (§3). Una copia **offline cifrata** dello stesso file (compito ops una tantum). **Rotazione senza data loss:** il file e `vaultRootKeys.ts` contengono **tutte** le coppie `rootKeyId` ancora in uso. Il rilascio sceglie la chiave dal `rootKeyId` **del keyring**, mai "la corrente", e firma con la chiave dello stesso id. Una chiave vecchia esce dal file e dal bundle solo quando `SELECT count(*) FROM "VaultKeyring" WHERE "rootKeyId" = <vecchio>` restituisce 0. Chi dimentica il PIN prima del re-seal si recupera quindi con la chiave vecchia. Dopo ogni rotazione va aggiornata anche la copia offline. | P-384 è disponibile ovunque in WebCrypto e in `node:crypto`; X25519 no in WebCrypto. La firma verificata dal client con la chiave fissata impedisce a chi controlla il server **senza** passphrase di forgiare un rilascio. |
| PIN del vault | **6 caratteri** `[A-Za-z0-9]`, **case-sensitive**, almeno 1 lettera **e** 1 cifra: solo cifre o solo lettere rifiutati dal client (il server non vede mai il PIN: lo Zod valida solo la forma di `authKey`). **Filtro dei PIN prevedibili** (regole in `PinPolicy.ts`, lista caricata in modo lazy nel chunk del vault, niente zxcvbn intero): rifiutati (1) anni `19xx`/`20xx` e date `ddmm`/`mmyy` in qualsiasi posizione; (2) sequenze e camminate di tastiera ≥3 (`abc`, `123`, `qwe`, `asd`, `zxc`, anche al contrario); (3) un carattere ripetuto ≥3 volte o schemi alternati (`a1a1a1`, `a1b2c3`); (4) nomi e parole comuni IT/EN (≈5.000 voci, minuscolo, prefisso ≥4 lettere) + cifre (`Marco1`, `luca99`); (5) nome, cognome ed email dell'account. Il confronto ignora il maiuscolo, perché le maiuscole all'inizio non aggiungono entropia reale. È un filtro solo lato client: il server non vede il PIN, e un client modificato lo può saltare. Protegge l'utente da sé stesso, non da un attaccante. | Il PIN a sole cifre (10⁶) cade in **minuti** su una GPU con DB + pepper. Con 62 simboli lo spazio sale a ~5,7·10¹⁰ (§2.4). Una password di 10 caratteri era più robusta, ma è stata scartata per usabilità (decisione §10.1). |
| Lockout online | `POST /vault/unlock`: al **6° errore consecutivo** `lockedUntil` con backoff progressivo 15m → 1h → 24h, email all'utente e riga di audit. Si azzera al primo sblocco riuscito. | Online il PIN è protetto dal server: senza `serverShare` la KEK non si deriva, e `serverShare` esce solo con `authKey` corretto. |
| Legacy | `crypto.ts` **non viene toccato**. `decryptContent` (`:40-72`) serve solo in lettura durante la migrazione. `hashPin` (`:10-12`) serve solo a riconoscere il vecchio PIN; poi `pinHash` viene azzerato. `EncryptedBlockComponent` è fuori scope. |  |

### 2.3 Cosa sa chi

| Soggetto | Possiede | Può decifrare? |
|---|---|---|
| Server/DB | `wrappedVkPin`, verifier con pepper, `serverShareEnc`, `escrowBlob`, `sealedRootShare`, ciphertext, file della chiave root **cifrato** | No |
| Leak del DB o dei backup | Tutto quanto sopra tranne il file root, senza pepper | No: niente brute force offline |
| Operatore con DB + pepper | Può fare brute force offline del PIN | **Sì, prima o poi**: al massimo ~1,2 GPU-anni per utente, giorni per un PIN "umano" (§2.4, rischio residuo §9.2) |
| Root (passphrase + file sul server) | `S_root` di qualsiasi utente, ma solo decifrando la chiave in memoria | Non con la procedura di recupero: gli manca `S_user` (160 bit, solo nel Kit). **Sì**, invece, se usa anche il pepper per il brute force del PIN (riga sopra) o se serve un bundle modificato (§9.1) |
| Server compromesso + passphrase catturata al rilascio | Chiave root in chiaro → `S_root` di tutti | No senza il Kit dell'utente; resta il brute force del PIN come sopra |
| Utente con Kit | `S_user` | No senza `S_root` e senza la procedura di recupero |

### 2.4 Costi di brute force (numeri onesti)

| Scenario | Spazio | Costo stimato |
|---|---|---|
| Online, da un client | Qualsiasi | Irrilevante: 6 errori → lockout progressivo, email |
| Leak del solo DB o dei backup | — | Nessun attacco: senza pepper i verifier non si testano e manca `serverShare` |
| DB + pepper (operatore o server compromesso), oppure dispositivo rubato con cache offline | 62⁶ ≈ **5,7·10¹⁰** combinazioni (≈3,7·10¹⁰ valide col vincolo lettera + cifra) | Argon2id 64 MiB, t=3: **~1000 tentativi/s per GPU di fascia alta**. Oracolo locale: `authVerifier` (o `serverShareEnc`) + `wrappedVkPin`. Esaurire le 3,7·10¹⁰ combinazioni valide richiede ≈ **1,2 GPU-anni**, ~7 mesi in media (le 5,7·10¹⁰ senza vincolo richiederebbero ~1,8 anni). Una farm di 50 GPU esaurisce lo spazio in ~9 giorni. |
| Come sopra, PIN a sole cifre (rifiutato) | 10⁶ | **Minuti** su una GPU |

- I PIN scelti da persone non sono uniformi: `Marco1`, `2024ab`, iniziali + anno cadono in **ore o giorni su una GPU**, perché un attaccante prova prima i dizionari. Il filtro di §2.2 toglie le forme più ovvie. Il numero vero è "giorni per un PIN umano, mesi per uno casuale, su una GPU".
- **Conseguenza:** chi ha DB + pepper (operatore, root con accesso al server, server compromesso) **arriva prima o poi al contenuto del vault**, senza Kit e senza procedura. Con un PIN di 6 caratteri non si chiude (§9.2). La UI del setup lo scrive in una riga: "Chi amministra il server, con accesso completo, può in teoria indovinare un PIN: sceglilo casuale".
- Con il dispositivo rubato la chiave AES "non-extractable" che cifra `serverShare` è comunque su disco e un'analisi forense la estrae: il costo è lo stesso della riga DB + pepper. È il **rischio residuo principale** (§9). Difese: sblocco offline disattivabile per dispositivo, "Ruota anche la chiave del vault" dopo un furto (§5.3).

---

## 3. Recupero da root in doppio controllo (interamente informatizzato)

Nessun passaggio fuori dall'applicazione: niente telefonate, carta, USB o macchine air-gapped. Il doppio controllo è crittografico (Kit + `S_root`) e procedurale (approvazione di root, codice in due metà, 72 ore annullabili, passphrase al rilascio).

### 3.1 Chi detiene cosa

- **Root** (utente `SUPERADMIN`):
  - chiavi private ECDH ed ECDSA P-384 in un **file sul server** (`VAULT_ROOT_KEY_PATH`), PKCS#8 cifrato con la **root passphrase** (Argon2id m=256 MiB, t=3, p=1 + AES-256-GCM). Il file sta fuori dalla webroot, fuori dal DB, fuori da `npm run backup` e dal pacchetto di deploy; ACL in sola lettura per l'utente di pm2;
  - **una copia offline cifrata** dello stesso file (compito ops una tantum, alla generazione);
  - la root passphrase, che conosce solo root (nel suo password manager). Non transita mai nei log e non viene mai salvata dal server;
  - drill trimestrale su un account di test, dal pannello admin.
- **Utente**: Recovery Kit (`S_user`) + account (password + email) + un dispositivo con login.
- **Server**: `escrowBlob`, `sealedRootShare` e il file della chiave root cifrato. Senza passphrase non può aprire niente di tutto questo.

La chiave root si genera **una volta** con lo script ops `npm run vault:root-keygen` (`backend/src/scripts/vaultRootKeygen.ts`): chiede la passphrase, scrive il file cifrato, stampa `rootKeyId` e le chiavi pubbliche da fissare in `vaultRootKeys.ts` (frontend) e nel backend. Non è un passaggio del recupero.

### 3.2 Protocollo

1. **Setup del keyring (P2).**
   - Il client sigilla `S_root` alla chiave root pubblica fissata, costruisce l'escrow e fa `POST /vault/keyring`.
   - **Il Kit viene mostrato solo dopo il 201, una sola volta.** Chi perde la gara riceve 409 e non vede mai un Kit non valido.
   - Formato: 32 caratteri Crockford base32 (160 bit) + 2 caratteri di controllo, mostrati in 8 gruppi da 4 + i 2 di controllo. Azioni: **scarica PDF** (generato nel browser) e **copia**. Poi l'utente riscrive **2 gruppi presi a caso**; senza questa conferma il setup non si chiude.
   - **Rigenerazione** da Impostazioni → Vault, solo a vault sbloccato (serve il PIN): nuovi `S_root` e `S_user`, nuovo escrow via `PUT /vault/keyring` con `vkProof`, stessa cerimonia di conferma. Il vecchio Kit smette di funzionare. Audit `vault.kit.regenerated` + email.
2. **Richiesta (utente).**
   - Da un dispositivo con login: "PIN del vault dimenticato → recupero assistito". L'interfaccia avverte subito che **senza Kit resta solo il reset**.
   - Il browser genera una coppia **ECDH P-384 effimera**. La privata è **non-extractable** e sta nell'IndexedDB raw `notiq-vault-device`, quindi `db.ts` non si tocca. È questa chiave a legare la richiesta al dispositivo.
   - `POST /vault/recovery {clientEphPub, reason?}` → stato `PENDING_APPROVAL`. Il server salva `fingerprint` `FP` (8 caratteri base32 di SHA-256(`clientEphPub`)), IP e user agent della richiesta.
   - Email + notifica in-app a tutte le sessioni: "È stato chiesto il recupero del vault. Non sei tu? Annulla".
   - **L'avviso vero non dipende dalle notifiche** (finding red team: con un JWT rubato `DELETE /api/notifications/all` le cancella tutte, e chi ha la mailbox cancella le email). `GET /vault/keyring` restituisce `openRecovery {id, status, fingerprint, createdAt, notBefore}` finché c'è una richiesta non terminale. `AppLayout` lo legge all'avvio, al ritorno del focus e ogni 15 minuti, e mostra un **banner non chiudibile** con "Annulla" in ogni sessione. È lo stesso schema di `RESET_PENDING` (§4.3). Come ulteriore garanzia, `deleteNotification`, `deleteAllNotifications` e `markAllNotificationsAsRead` escludono `type=VAULT_RECOVERY` finché la richiesta collegata è aperta.
3. **Approvazione (root, pannello admin).**
   - Nuovo tab "Recupero vault" in `AdminPage`: account, email, data, IP/UA della richiesta, `FP`, storico delle richieste, stato del keyring.
   - Root **approva** (`POST /admin/vault-recovery/:id/approve`) o **rifiuta** con motivo (`…/reject`). Una richiesta non approvata entro 7 giorni scade.
   - L'approvazione non rilascia nulla: fa solo partire la verifica dell'identità.
4. **Codice monouso in due metà (sistema).**
   - All'approvazione il server genera un codice di 16 caratteri Crockford (80 bit), diviso in **metà A** e **metà B** da 8 caratteri (40 bit ciascuna). Root non lo vede mai.
   - **Metà A → solo il dispositivo richiedente**: il server la cifra per `clientEphPub` (ECDH P-384 con chiave effimera del server + HKDF + AES-GCM) e la recapita come **notifica in-app** del sistema esistente (`NotificationType.VAULT_RECOVERY`, `data.sealedCodeA`). La notifica compare in tutte le sessioni, ma solo il dispositivo con la chiave privata effimera la decifra e mostra il codice; le altre vedono "Codice disponibile sul dispositivo che ha fatto la richiesta".
   - **Metà B → email** dell'account.
   - Il server salva solo `HMAC(PEPPER, metà)` di ciascuna, con scadenza **24 ore** e **5 tentativi** in tutto. Stato `PENDING_CODE`.
   - L'utente digita **entrambe** le metà nel form dedicato sul dispositivo richiedente: `POST /vault/recovery/:id/confirm {codeA, codeB}` (confronto a tempo costante). Al 5° errore o alla scadenza la richiesta va in `EXPIRED` e serve una richiesta nuova.
5. **Attesa di 72 ore (annullabile).**
   - Codice corretto → stato `WAITING`, `notBefore = now + 72h`.
   - Email + notifica a **tutte le sessioni** con `FP` e il pulsante "Non sei tu? Annulla", più il banner non chiudibile guidato da `openRecovery` (step 2), che mostra il conto alla rovescia fino a `notBefore`. **Qualsiasi sessione** può annullare con `DELETE /vault/recovery/:id` → `CANCELLED`. Il link nell'email porta alla stessa azione dopo il login.
   - Limite onesto: una vittima che in 72 ore non apre mai l'app su nessun dispositivo e non legge la posta non viene avvisata. Qui la difesa è il Kit, non la finestra.
   - Promemoria email a 24 ore dalla scadenza dell'attesa.
6. **Rilascio (root, solo dopo `notBefore`).**
   - Nel tab admin la richiesta appare "Pronta per il rilascio". Root digita la **root passphrase**: `POST /admin/vault-recovery/:id/release {passphrase}`.
   - Il server ricontrolla stato `WAITING`, `now ≥ notBefore`, richiesta non annullata né scaduta. Poi, **solo in memoria**: Argon2id(passphrase) → decifra il file → prende la coppia del **`rootKeyId` del keyring** (§2.2) → importa le chiavi non-extractable → apre `sealedRootShare` → sigilla `S_root` a `clientEphPub` → firma ECDSA `requestId|userId|FP|notBefore|sha256(seal)` → verifica la firma con la chiave pubblica fissata.
   - Salva `rootShareForClient` + `rootSignature`, stato `RELEASED`, **con la transizione condizionata** `updateMany({where:{id, status:'WAITING', notBefore:{lte: now}}})`: se `count !== 1` (per esempio l'utente ha annullato durante l'Argon2id) risponde 409 e non salva nulla (§3.3). La chiave in chiaro e la passphrase **non vengono mai persistite né loggate**: niente log del body su questa route, `redact` Pino su `passphrase` come rete di sicurezza, buffer azzerati appena possibile (best effort in Node).
   - Il rilascio scade dopo 7 giorni: `rootShareForClient` viene cancellato e la richiesta va in `EXPIRED`.
7. **Completamento (solo sul dispositivo richiedente).**
   - Il client verifica la firma con la chiave fissata nel bundle e **che l'`FP` firmato coincida con l'impronta della propria chiave**. Poi apre `S_root` con la privata effimera, l'utente inserisce il **Kit**, il client calcola RK e ottiene VK.
   - **Nuovo PIN** obbligatorio (policy §2.2); **rotazione di `S_root` e `S_user`**, perché il vecchio `S_root` è passato in chiaro nella memoria del server: nuovo escrow e **nuovo Kit**, con la stessa cerimonia del setup. Il vecchio Kit non vale più.
   - `POST /vault/recovery/:id/complete {payload, vkProof}` (`payload` = `{rev, wrap, escrow}`). È autorizzato da **`vkProof`** (firma con `vkSigKey`, sbustata con il VK recuperato, §2.1), non da `authKeyOld`: così il recupero con PIN dimenticato può davvero scrivere il nuovo wrap (fix del finding).
   - **Ordine anti-perdita del nuovo Kit** (finding red team: se la risposta di `complete` si perde, il vecchio Kit è già morto e il nuovo non è mai stato mostrato):
     1. il client genera nuovo PIN wrap, nuovi `S_root'`/`S_user'` ed escrow, e firma `payload`;
     2. salva `{requestId, payload, vkProof}` in `notiq-vault-device`: sono solo ciphertext e una firma, niente segreti in chiaro;
     3. mostra il **nuovo Kit** con la cerimonia completa (PDF/copia + 2 gruppi). **Solo dopo** manda `complete`;
     4. `complete` è **idempotente**: il server salva `completedPayloadHash = sha256(payload)`. Se lo stesso `payload` arriva su una richiesta già `COMPLETED`, risponde 200;
     5. se la scheda si chiude, alla riapertura il client trova il pending: con la richiesta `RELEASED` rimanda lo stesso `payload`; con `COMPLETED` e hash uguale chiude e pulisce; con hash diverso o richiesta scaduta scarta il pending e dice all'utente che il Kit appena annotato **non** è valido, e che vale quello precedente;
     6. su 200 cancella il pending e la chiave effimera.
   - Il server cancella `rootShareForClient` nella stessa transizione condizionata `RELEASED → COMPLETED`. Audit + email + notifica.
   - Lo stesso ordine vale per la rigenerazione del Kit da Impostazioni (`PUT` con pending salvato e retry dello stesso `payload`). Per il setup il problema non c'è: se il 201 si perde, l'utente conosce il PIN e rigenera il Kit dalle impostazioni.

### 3.3 Limiti e rate limit

| Cosa | Limite |
|---|---|
| Richieste per utente | Al massimo 1 aperta e 3 ogni 30 giorni, **senza contare** quelle `CANCELLED` o `REJECTED`: 3 richieste aperte da un attaccante con JWT rubato e annullate dalla vittima non la escludono dal recupero. Lo spam resta limitato da "1 aperta" + `POST /vault/recovery` 3/h, e ogni richiesta manda un'email all'utente |
| Approvazione | Entro 7 giorni, poi `EXPIRED` |
| Codice A+B | 24 ore, 5 tentativi in tutto; `confirm` 5/15 min |
| Attesa | 72 ore da `confirm`, annullabile da ogni sessione |
| Rilascio | Solo dopo `notBefore`; scade dopo 7 giorni |
| Passphrase root | **Contatori persistiti nel DB, per account admin**, non in memoria: un restart di pm2 non li azzera. Ogni errore scrive **in modo sincrono** una riga `AuditLog` `vault.recovery.release_failed` con `userId = admin`, senza passare da `logEvent`, che ingoia gli errori: se la scrittura fallisce, il rilascio viene rifiutato. Prima di Argon2id si contano le righe (indice `[event, createdAt]` già presente): 3 errori in 15 min per quell'admin → 429; 10 in 24h → quell'admin è bloccato per 24h. Gli altri `SUPERADMIN` restano liberi, quindi un co-admin ostile non blocca tutti i rilasci. Ogni errore manda un'email a tutti i `SUPERADMIN` |
| Lockout dello sblocco | Non si applica al recupero |
| Transizioni di stato | **Tutte** condizionate: `updateMany({where:{id, status: <atteso>, …}})`, e `count !== 1` → 409. `confirm` incrementa `attempts` **prima** del confronto, con `where attempts < 5`. `DELETE` e `release`, `release` e `complete` non possono più sovrapporsi: vince la prima transizione, l'altra riceve 409 |

### 3.4 Audit

Ogni transizione produce una riga `AuditLog` (`logEvent`) e un'email all'utente: `vault.recovery.requested`, `.approved`, `.rejected`, `.code_sent`, `.code_failed`, `.confirmed`, `.cancelled`, `.released`, `.release_failed` (solo admin), `.completed`, `.expired`. Il pannello admin mostra la catena per richiesta.

### 3.5 Cosa root da solo non può fare con la procedura (e cosa può fare fuori)

1. **Crittografia:**
   - l'escrow richiede `S_root || S_user`; root, anche con passphrase e accesso al server, ha solo `S_root`. `S_user` sta solo sul Kit e in `userShareUnderVk`, cifrato con VK;
   - sostituire `clientEphPub` non gli dà niente in più: ha già `S_root`, gli manca comunque `S_user`. Il client legittimo rifiuta un `FP` firmato diverso dal proprio.
2. **Procedura:** approvazione + codice in due metà (dispositivo + email) + 72 ore annullabili da ogni sessione + passphrase al rilascio + firma verificata dal client con la chiave fissata nel bundle.
3. **Email + sessione compromesse** (attaccante con mailbox e un JWT, o un dispositivo con login): può superare il controllo del codice e cancellare notifiche ed email, ma non il banner guidato da `GET /vault/keyring` (§3.2.2). Le 72 ore avvisano quindi tutte le altre sessioni, che possono annullare, e **senza il Kit** il rilascio non gli serve.
4. **Server compromesso + passphrase catturata al rilascio**: l'attaccante ottiene la chiave root e quindi `S_root` di tutti. Senza il Kit di ciascun utente non decifra nulla (rischio dichiarato, §9).
5. **Vie "da solo" che esistono e non si chiudono** (il requisito "root mai da solo" vale **solo** per la procedura di recupero):
   - **brute force offline del PIN** con DB + pepper: al massimo ~1,2 GPU-anni per utente, giorni per un PIN "umano" (§2.4, §9.2). Si chiuderebbe solo con un segreto più lungo o con WebAuthn PRF, entrambi esclusi in questa versione (§10.1);
   - **bundle o service worker manomessi**: chi controlla l'origin serve una volta un JS modificato, il SW lo mette in cache, e al successivo sblocco o recupero PIN e Kit escono. Questo aggira **tutti** i controlli di questa sezione, Kit compreso. Una PWA non ha un pinning del bundle; le mitigazioni rilevano, non impediscono (§9.1).
   - Nella UI (setup del vault e pagina "Come funziona il vault") c'è una frase esplicita: "Chi gestisce il server può sempre, in teoria, modificare l'app per leggere il vault. La cifratura protegge da furti del database, backup e intrusioni parziali, non da un amministratore del server malintenzionato".

---

## 4. Reset stile GitHub

Solo online. Si può fare sia a vault bloccato sia sbloccato, perché serve proprio quando il PIN è perso.

1. **Sfida.** `POST /vault/reset/challenge` restituisce:
   - un codice generato dal server di 12 caratteri Crockford `XXXX-XXXX-XXXX` (circa 60 bit), salvato come hash in `VaultRequest(type=RESET)`, valido 10 minuti, 5 tentativi;
   - i **conteggi reali**: note, credenziali, tag, versioni, allegati.
2. **Dialog.**
   - Elenco di cosa verrà distrutto, avviso "Irreversibile: neanche l'amministratore potrà recuperarlo", codice in un blocco monospace.
   - Un campo in cui riscrivere il codice (case-insensitive, trattini facoltativi; il paste **resta permesso** come su GitHub, per accessibilità e password manager) e un campo con la password dell'account.
   - Il pulsante resta disabilitato finché entrambi non sono validi. Si usa `ConfirmDialog`, mai `confirm()`.
3. **`POST /vault/reset {requestId, code, password}`** (bcrypt, rate limit 3 ogni 15 min).
   - Stato `RESET_PENDING`, `resetScheduledAt = now + 7g`.
   - **Da subito**: sblocco e scritture sul vault rifiutati, vault nascosto su tutti i dispositivi.
   - Email con link di annullamento + banner in ogni sessione. `POST /vault/reset/cancel` riporta a READY.
   - È la difesa contro "mailbox compromessa → reset password → vault distrutto". La finestra di 7 giorni è decisa (§10.5): non esiste la cancellazione immediata.
4. **Hard delete.** Lo esegue un job periodico in `vault.service`, avviato da `app.ts` come gli altri `setInterval`, in **una transazione**:
   - `deleteMany Note {userId, isVault:true}`; NoteVersion, TagsOnNotes e Attachment cascadono;
   - cancellazione dei `Tag {isVault}`;
   - annullamento delle `VaultRequest` aperte;
   - azzeramento dei campi crittografici del keyring, `status=NONE`, **`epoch = epoch+1` sulla riga, che non viene mai cancellata**.
   - Dopo il commit: unlink dei file degli allegati (`npm run prune` come rete di sicurezza), audit `vault.reset` con i conteggi, email.
5. **Altri dispositivi.**
   - Solo una risposta **esplicita** `GET /vault/keyring → 200 {status:'NONE'|'RESET_PENDING', epoch > epoch in cache}` fa cancellare le note vault locali in Dexie, i relativi item della syncQueue e la cache.
   - Un 404 o un errore di rete non cancellano **mai** nulla: sono lo stato UNKNOWN (fix del finding "404 nudo cancella tutto" durante i deploy).
   - Le scritture rimaste in coda con la vecchia epoch ricevono 422 `errors.vault.stale` → `failed` (`syncService.ts:1004-1015`). Nessun resurrezione: l'epoch persiste sul keyring (fix del finding "epoch solo in AuditLog").
6. Il setup dopo un reset riparte con la nuova epoch. I vecchi envelope non verranno mai più accettati.
7. Il testo falso attuale (`en.json:349-350`, `it.json:447-448`) e il flusso in `VaultUnlock.tsx:28-35` vengono sostituiti.

---

## 5. Offline, multi-dispositivo, logout

### 5.1 Macchina a stati (`VaultPage.tsx:192-198`), per utente

| Stato | Condizione | UI |
|---|---|---|
| UNKNOWN | Offline senza cache per l'utente, o GET fallita o non 200 | "Connettiti una volta per usare il vault su questo dispositivo". **Mai il setup.** |
| NONE | 200 `status:NONE`, online | Setup; se `legacyCount>0` o c'è un `pinHash` locale, parte la migrazione |
| RESET_PENDING | 200 | Banner con il pulsante "Annulla reset" |
| READY | 200 `READY`, oppure cache presente offline | Sblocco |
| UNLOCKED | VK in memoria | Contenuto |

### 5.2 Offline

- Lo sblocco usa `wrappedVkPin` in cache in `vault-storage.byUser[userId]` e `serverShare` cifrato con una chiave AES non-extractable del dispositivo, in `notiq-vault-device`. Il tag GCM fa da verifica del PIN.
- Setup, cambio PIN, reset, recupero e migrazione sono disabilitati, con spiegazione.
- Lo sblocco offline è **attivo di default** e si disattiva per dispositivo (§10.1). Offline non c'è lockout: gli errori non arrivano al server.
- Gli edit vengono cifrati **prima** della scrittura in Dexie e messi in coda.
- Un item mai scaricato è in sola lettura: "Non ancora disponibile su questo dispositivo".
- Onestà: la cache offline permette a chi ruba il dispositivo un brute force offline. Con il PIN alfanumerico costa al massimo ~1,2 GPU-anni (§2.4), giorni per PIN prevedibili: è il rischio residuo principale. Nelle impostazioni c'è "Disattiva sblocco offline su questo dispositivo".

### 5.3 Multi-dispositivo

- Il keyring è sul server. Il setup concorrente si risolve con la regola "create-only": 409 → sblocco con il PIN del vincitore.
- Il cambio PIN è un `PUT` con CAS su `rev` e `vkProof`.
- Un dispositivo offline accetta il vecchio PIN finché non torna online: VK è lo stesso, quindi non c'è rischio per i dati. Il ritardo va documentato.
- In "Cambia PIN" c'è l'opzione **"Ruota anche la chiave del vault"**, che ri-cifra tutti gli item lato client e incrementa l'epoch. Serve quando il PIN è stato visto da qualcuno, per rendere inutile la cache di un telefono rubato.

**Edit concorrenti: push "latest-state".** Qui c'è il fix del finding sulla catena `baseHash` rotta dal riordino di `hasQueuedReferenceCreate` e dal backoff per item.
- La riga Dexie della nota vault tiene `vaultBaseHash`: lo sha256 dell'ultimo ciphertext confermato dal server. È un campo non indicizzato: nessun bump di versione Dexie, solo il tipo in `LocalNote`.
- In `syncPush`, ramo NOTE UPDATE (`syncService.ts:~771`), per le note `isVault` il payload viene ricostruito al momento della push: `content` = contenuto **attuale** in Dexie, `baseHash` = `vaultBaseHash` attuale.
- Su 200 si imposta `vaultBaseHash = sha256(contenuto inviato)`, non quello corrente, così un edit fatto durante la push resta pendente.
- Gli item successivi della stessa nota diventano idempotenti. Ordine e backoff non contano più.
- La coda non riceve mai `baseHash`, quindi `noteService.ts:149-166` resta com'è.

**Conflitti.**
- Il server risponde 422 `errors.vault.conflict`, che è già terminale (`failed`) anche nei bundle vecchi.
- Allo sblocco il vault trova gli item `failed` delle note vault e salva la versione locale come nuova nota "(copia in conflitto)", ri-cifrata con il nuovo `noteId` nell'AAD. Poi accetta la versione del server e rimuove l'item.
- Niente sovrascritture silenziose.

### 5.4 Logout

- `authStore.ts:76`: `resetVault()` diventa `lockVault()`, che azzera VK in memoria.
- Copre anche `api.ts:36/:61` e `useKanbanRealtime.ts:154`, che passano tutti da `logout`.
- Il materiale in cache è per `userId`, quindi un altro utente sullo stesso browser non lo vede.
- Pulizia esplicita: Impostazioni → "Rimuovi vault da questo dispositivo".
- L'auto-lock a 10 minuti (`vaultStore.ts:4-18`) resta.

---

## 6. Migrazione dei vault esistenti in prod (zero data loss) e chiusura del buco di sovrascrittura

### 6.1 Chiusura del buco

1. **P0, subito, senza crittografia né schema.**
   - `CredentialForm.tsx:63-67` e il ramo vault di `NoteEditor`: con contenuto `''`, sola lettura con placeholder, **mai** `EMPTY_CREDENTIAL` modificabile.
   - Online: fetch pigro di `GET /notes/:id` (`notes.ts:65`) per riempire Dexie.
   - `VaultPage.tsx:92-102` crea le note vault con un documento iniziale non vuoto.
2. **P2, definitivo.**
   - Ogni item vault è sempre un envelope, anche se vuoto, quindi `''` vuol dire solo "non caricato".
   - Idratazione tramite `POST /vault/items` (ciphertext + `contentHash`), scritta in Dexie solo dove la riga locale è `synced`.
   - Il server impone CAS su `baseHash` + formato envelope + epoch corrente.

### 6.2 Migrazione

È client-side e si attiva con `status:NONE` + (`legacyCount>0` oppure `pinHash` locale).

0. **Flush.** `syncPush` deve svuotare la coda. Se restano item vault pendenti o `failed`, la migrazione si blocca con un messaggio. Il server non ha ancora il keyring, quindi le scritture in chiaro in coda passano.
1. **Nuovo PIN del vault** (policy §2.2).
   - `POST /vault/keyring {…, migrationState:'IN_PROGRESS'}`. Il Kit si mostra dopo il 201.
   - Su 409, un altro dispositivo ha vinto: si sblocca con il suo PIN e si prosegue.
2. **Vecchi PIN.** Verificati con `hashPin` se c'è un `pinHash` locale. Ciclo su più PIN, perché ogni dispositivo può averne avuto uno diverso.
3. **Sorgente = server** (`POST /vault/items`), mai la copia locale, che può essere vecchia (`syncService.ts:172-185`). Per ogni item:
   - nota in chiaro (con `isEncrypted` true o false) → envelope `{t,c}`;
   - credenziale v2 o legacy → `decryptContent` (`crypto.ts:40`) → envelope;
   - roundtrip in memoria `decrypt(envelope) == originale` prima dell'invio.
4. **`POST /vault/migrate`** in batch da 200 con `baseHash = sha256(contenuto server)`. In una transazione per item:
   - CAS;
   - **snapshot forzato del plaintext come NoteVersion**, così resta un rollback;
   - `title=''`, `isEncrypted=true`, `searchText=null`, `ydocState=null`.
5. **Verifica dai byte del server.**
   - Nuova `POST /vault/items` con `{ids}`, decifratura e confronto con gli originali ancora in memoria.
   - Solo per gli id verificati: `POST /vault/finalize {ids}`.
   - Il server ricontrolla che il contenuto sia un envelope dell'epoch corrente e **solo allora** cancella le NoteVersion non-envelope di quegli id.
   - È il fix del finding "purge prima della prova": un bug del client resta reversibile fino alla finalizzazione.
6. **Item non decifrabili** (PIN di un altro dispositivo): restano **byte-identici**, marcati "Bloccato con un PIN precedente — inseriscilo per aggiornare". Sono in sola lettura e si possono riprovare. **La migrazione non cancella mai nulla.**
7. **Fine.** Quando `legacyCount=0` si passa a `migrationState=DONE`; in locale gli envelope vanno in Dexie e `pinHash=null` (fix del finding "pinHash reversibile persistito per sempre").
8. **Migrazione interrotta** (finding red team: un client che fa `migrate` e poi muore lascia per sempre gli snapshot NoteVersion in chiaro).
   - Ad ogni sblocco con `migrationState=IN_PROGRESS` il client riprende **da solo** i passi 5–7: riscarica, verifica, `finalize`. Non serve che l'utente riapra il wizard.
   - Il job periodico di `vault.service` (lo stesso del reset) elenca nel pannello admin gli utenti `IN_PROGRESS` da più di 7 giorni e manda loro un'email di sollecito. Il server **non** cancella gli snapshot da solo: senza la verifica del client sarebbe il "purge prima della prova" già scartato. Finché l'utente non sblocca, quel plaintext resta (§9.10).

### 6.3 Bundle vecchi in cache (PWA)

- Dopo che esiste il keyring, le scritture in chiaro ricevono 422 `errors.vault.plaintextRejected` → `failed`, con banner rosso invece di un backoff silenzioso.
- Al primo avvio del bundle nuovo, le righe vault non `synced` con contenuto non-envelope diventano input di migrazione: vengono cifrate e salvate come "copia in conflitto". Nessun edit perso.

### 6.4 Spostamento nel vault (`NoteEditor.tsx:279-306`)

- Richiede il vault sbloccato. La cifratura avviene lato client.
- Il server, in una transazione:
  - cancella le righe `SharedNote`, imposta `isPublic=false`, `ydocState=null`, `searchText=null`;
  - **chiude le connessioni Hocuspocus** della nota, con il disconnect mirato già usato per l'SSE.
- Le versioni in chiaro si cancellano con lo stesso `finalize`, dopo la verifica del re-download.
- Note con allegati: spostamento bloccato.

### 6.5 Operazioni

- `pg_dump` prima del deploy di P2 (lo fa `Deploy-Server.ps1`).
- I dump e gli ZIP `npm run backup` precedenti contengono plaintext e vanno distrutti dopo la retention concordata.
- Script admin con il `legacyCount` per utente. Gli utenti che non aprono mai il vault restano in chiaro: il server non può cifrare al loro posto. Si mostra un banner di sollecito.

---

## 7. Modello dati, migration, API, file toccati

### 7.1 `schema.prisma` (TIER 1)

**Una** migration nuova `20261001000000_vault_e2ee`. Nessuna modifica alle migration applicate, mai `db push`.

```prisma
enum VaultStatus { NONE READY RESET_PENDING }
enum VaultMigrationState { NONE IN_PROGRESS DONE }
enum VaultRequestType { RESET RECOVERY }
enum VaultRequestStatus { PENDING_APPROVAL PENDING_CODE WAITING RELEASED COMPLETED CANCELLED EXPIRED REJECTED }
// reset: PENDING_CODE → COMPLETED | EXPIRED
// recupero: PENDING_APPROVAL → PENDING_CODE → WAITING → RELEASED → COMPLETED (| CANCELLED | EXPIRED | REJECTED)
enum NotificationType { … VAULT_RECOVERY }   // valore aggiunto all'enum esistente, nella stessa migration

model VaultKeyring {            // la riga sopravvive al reset (epoch durevole)
  userId String @id  (User, onDelete: Cascade)
  status VaultStatus @default(NONE)
  epoch Int @default(0)
  rev Int @default(0)            // CAS
  kdf String?  kdfParams Json?  pinSalt Bytes?  wrappedVkPin Bytes?
  authVerifier Bytes?  serverShareEnc Bytes?  pepperKeyId String?
  vkSigPub Bytes?  wrappedVkSigKey Bytes?   // vkProof = firma ECDSA P-256, niente segreto bearer sul server
  escrowBlob Bytes?  sealedRootShare Bytes?  rootKeyId String?  userShareUnderVk Bytes?
  migrationState VaultMigrationState @default(NONE)
  failedAttempts Int @default(0)  lockedUntil DateTime?  resetScheduledAt DateTime?
  createdAt DateTime @default(now())  updatedAt DateTime @updatedAt
}

model VaultRequest {             // una sola tabella per reset e recupero
  id String @id @default(uuid())  userId String (Cascade)
  type VaultRequestType  status VaultRequestStatus
  codeHash String?               // reset: HMAC(PEPPER, codice)
  codeAHash String?  codeBHash String?   // recupero: HMAC(PEPPER, metà A/B), mai in chiaro
  expiresAt DateTime?  attempts Int @default(0)   // scadenza e tentativi del codice (reset 10 min, recupero 24h; max 5)
  clientEphPub Bytes?  fingerprint String?  notBefore DateTime?
  requestIp String?  requestUserAgent String?   // mostrati a root nel pannello admin
  approvedById String?  approvedAt DateTime?  rejectReason String?
  releasedById String?  releasedAt DateTime?  releaseExpiresAt DateTime?
  rootShareForClient Bytes?  rootSignature Bytes?  reason String?
  completedPayloadHash String?   // complete idempotente (§3.2.7)
  createdAt DateTime @default(now())  completedAt DateTime?  cancelledAt DateTime?  cancelledBy String?
  @@index([userId, type, status])
}
```

- `User` riceve solo le back-relation. `Note`, `NoteVersion` e `Tag` restano invariati.
- Audit: `AuditLog` esistente tramite `logEvent`, con eventi `vault.*`.
- Nuova env `VAULT_PEPPER_KEY`: se manca o è malformata il boot **prosegue** (decisione D1 del piano P1): log `vault secrets` con lo stato e `/api/vault/*` risponde 503. Va in un backup offline **separato** dai dump del DB.
- **Chiave root: non nel DB.** File cifrato in `VAULT_ROOT_KEY_PATH` (formato `{kdf:"argon2id", kdfParams, salt, iv, ct}`, dove `ct` è la mappa `{rootKeyId → PKCS#8 ECDH + ECDSA}` cifrata con la root passphrase; contiene ogni id ancora referenziato da un keyring, §2.2). Escluso da `npm run backup`, da `Build-Package.ps1` e da `robocopy` del deploy. Se manca, il boot **non** fallisce: il rilascio risponde 503 `errors.vault.rootKeyUnavailable` e il resto del vault funziona. Una copia offline cifrata del file, separata dal backup del pepper.
- La metà A del codice non si salva in `Notification` in chiaro: `data.sealedCodeA` è cifrato per `clientEphPub` (§3.2.4), quindi chi legge la tabella o un'altra sessione non la vede.

### 7.2 API

> Nota: le altre deviazioni da questo design (D1, D2 (password dell'account obbligatoria su POST /vault/keyring, plan §10), rate limit per utente, lock di P1, regole su allegati e versioni in chiaro) sono negli addendum in fondo a `2026-09-30-vault-p1-plan.md`, che prevalgono su questo testo.

Nuovo `backend/src/routes/vault.ts`, plugin con `onRequest:[fastify.authenticate]`. I byte viaggiano in base64url con lunghezze esatte in Zod.

| Endpoint | Body / risposta | Note |
|---|---|---|
| `GET /api/vault/keyring` | **Sempre 200** `{status, epoch, rev, kdf, kdfParams, pinSalt, wrappedVkPin, wrappedVkSigKey, rootKeyId, migrationState, lockedUntil, resetScheduledAt, legacyCount, openRecovery?}` | Mai 404 per dire "nessun vault". `openRecovery {id, status, fingerprint, createdAt, notBefore}` c'è finché esiste una richiesta di recupero non terminale, e guida il banner non chiudibile (§3.2.2) |
| `POST /api/vault/keyring` | `{expectedEpoch, kdf:'argon2id', kdfParams{m≥65536,t≥3,p:1}, pinSalt16, wrappedVkPin60, authKey32, vkSigPub, wrappedVkSigKey, serverShare32, escrowBlob, sealedRootShare, rootKeyId: enum di id fissati, userShareUnderVk}` | 409 se READY; 5/h. `authKey`, `serverShare` e il body di tutte le route vault sono esclusi dai log (`redact`) |
| `POST /api/vault/unlock` | `{authKey}` → `{serverShare}` | Al 6° errore consecutivo lockout 15m → 1h → 24h, email + audit; 10/min |
| `PUT /api/vault/keyring` | `{payload, vkProof}`, con `payload` = JSON di `{rev, wrap?, escrow?, rotate?}` | Cambio PIN, rigenerazione Kit (nuovo escrow), rotazione root/VK. Firma verificata con `vkSigPub` (§2.1), poi CAS `updateMany where rev`; 409 se `rev` è vecchio, quindi niente replay; 10/h |
| `POST /api/vault/items` | `{ids?, after?}` → `[{id, noteType, content, contentHash, updatedAt, isTrashed}]` | Solo note vault del proprietario; 60/min. Era `GET ?ids=`: diventa POST per RT-2 (`maxQueryString` di IIS) |
| `POST /api/vault/migrate` | `{items ≤200: {id, baseHash, content, noteType}}` | CAS per item + snapshot forzato |
| `POST /api/vault/finalize` | `{ids ≤500}` | Controlla gli envelope, cancella le versioni in chiaro, imposta DONE |
| `POST /api/vault/reset/challenge` | → `{requestId, code, expiresAt, counts}` | 5/h |
| `POST /api/vault/reset` · `POST /api/vault/reset/cancel` | `{requestId, code, password}` | 3/15min |
| `POST /api/vault/recovery` | `{clientEphPub97, reason? ≤500}` → `{id, fingerprint}` | `PENDING_APPROVAL`; 1 aperta, 3 ogni 30 giorni (escluse `CANCELLED`/`REJECTED`), 3/h |
| `GET /api/vault/recovery/:id` | → `{status, fingerprint, notBefore, sealedCodeA?, rootShareForClient?, rootSignature?}` | `sealedCodeA` solo in `PENDING_CODE`, il seal solo in `RELEASED`: sono comunque cifrati per `clientEphPub` |
| `POST /api/vault/recovery/:id/confirm` | `{codeA, codeB}` (8+8 Crockford) | Tempo costante; 5 tentativi totali, 24h; 5/15min → `WAITING`, `notBefore=now+72h` |
| `DELETE /api/vault/recovery/:id` | | Da **qualsiasi** sessione dell'utente, in ogni stato non terminale → `CANCELLED` |
| `POST /api/vault/recovery/:id/complete` | `{payload, vkProof}`, con `payload` = JSON di `{rev, wrap, escrow}` | Solo `RELEASED` e non scaduto, transizione condizionata; cancella `rootShareForClient`. Idempotente: stesso `payload` su `COMPLETED` → 200 (`completedPayloadHash`) |
| Admin (SUPERADMIN), `backend/src/routes/vaultAdmin.ts`: `GET /api/admin/vault-recovery` (+ `/:id` con audit) · `POST /:id/approve` · `POST /:id/reject {reason}` · `POST /:id/release {passphrase}` | | Approve genera e recapita il codice A/B. Release solo in `WAITING` dopo `notBefore`. Passphrase: contatori in `AuditLog` **per admin** (3/15 min, 10/24h → quell'admin bloccato 24h), che sopravvivono al restart; firma verificata prima di salvare |

**Modifiche a codice esistente.**
- `notes.ts:18-26`: `baseHash` facoltativo `^[0-9a-f]{64}$`.
- `note.service.ts`, create (`:27-79`) e update (`:185-279`), se il keyring è READY e la nota è o diventa vault:
  - envelope dell'epoch corrente, `title=''`, `isEncrypted=true`, `searchText=null`;
  - `baseHash` obbligatorio se c'è `content` e uguale a `sha256(content)`, altrimenti 422 conflict.
  - Il passaggio false→true fa la transazione di §6.4. Il passaggio true→false richiede il plaintext nella stessa richiesta.
- `noteVersion.service` restore: rifiuta le versioni non-envelope per le note vault (fix del bypass).
- `sharing.service.ts`: `shareNote` e `updateSharedNoteContent` rifiutano `isVault`; `/share/notes/accepted` esclude `isVault` (fix del bypass).
- `hocuspocus.ts`: `onAuthenticate` rifiuta `isVault`; `store()` non persiste se `isVault` (fix del finding sulla sovrascrittura con plaintext).
- `import.ts:25/:51` e `attachments.ts:29`: rifiutano `isVault`.
- `search.service.ts:39/:68`: aggiunto `AND "isVault"=false`. `ai.service.ts:46`: blocca anche `isVault`.
- Promemoria di note vault: testo push generico.
- `notification.service.ts`: nuovo tipo `VAULT_RECOVERY` (richiesta aperta, codice disponibile, attesa avviata con "Annulla", rilascio, completamento), testo generico nelle push. `deleteNotification`, `deleteAllNotifications` e `markAllNotificationsAsRead` (usati da `notification.routes.ts:38-60`) escludono `VAULT_RECOVERY` finché la richiesta collegata non è terminale. Basta una clausola `where`; le route restano invariate.
- `utils/logger.ts`: `redact` su `passphrase`, `*.codeA`/`*.codeB`, `*.authKey` e `*.serverShare` come rete di sicurezza.
- **Manifest di release firmato (P5, mitigazione di §9.1):** `Build-Package.ps1` genera `release-manifest.json` con lo sha256 di ogni file di `dist/` (bundle, `sw.js`, `index.html`) e lo firma con una chiave di release che **non sta sul server**. Manifest e firma vengono pubblicati nel tag git/GitHub release. Lo script `scripts/verify-prod-bundle.mjs`, lanciato da una macchina **esterna** al server (anche la CI), scarica gli asset serviti da `notiq.epartner.it` e li confronta col manifest. È solo **rilevazione**: un operatore ostile può servire il bundle modificato a un solo utente.
- Nuovi service: `vault.service.ts`, `vaultRecovery.service.ts` (macchina a stati, codici, scadenze), `vaultRootKey.service.ts` (carica il file root, Argon2id della passphrase, unseal/seal/firma solo in memoria).
- Nuovo script ops `backend/src/scripts/vaultRootKeygen.ts` (`npm run vault:root-keygen`), una tantum.

### 7.3 Frontend

- **Nuovi file:**
  - `utils/vaultCrypto.ts` (in `utils`, perché serve anche a `syncService` senza import tra feature) e `utils/vaultRootKeys.ts`;
  - `features/vault/`: `vaultApi.ts`, `deviceKeyStore.ts`, `VaultMigrate.tsx`, `VaultResetDialog.tsx`, `VaultRecovery.tsx`, `RecoveryKitSheet.tsx`, `VaultOfflineNotice.tsx`;
  - sezione Vault in `SettingsPage` (cambio PIN, rigenera Kit, disattiva sblocco offline su questo dispositivo, rimuovi vault dal dispositivo);
  - `features/vault/`: anche `RecoveryCodeForm.tsx` (metà A + metà B) e `PinPolicy.ts` (validazione 6 caratteri, lettera + cifra, blocklist);
  - `features/admin/tabs/VaultRecoveryTab.tsx`: lista richieste, dettaglio con IP/UA/`FP`/audit, Approva, Rifiuta, Rilascia con campo passphrase (`type=password`, `autocomplete=off`, mai in store o localStorage). L'impronta si calcola con `utils/vaultCrypto.ts`, niente import da `features/vault/`.
- **`vaultStore.ts`:**
  - chiave `vault-storage` invariata; `partialize` (`:65`) **aggiunge** `byUser: Record<userId,{status,epoch,rev,kdfParams,pinSalt,wrappedVkPin,rootKeyId}>`;
  - `isSetup` e `pinHash` restano come segnale legacy e vengono azzerati dopo la migrazione;
  - `vk: CryptoKey|null` in memoria sostituisce `pin` (`:24`).
- **Consumatori da aggiornare:**
  - `VaultPage.tsx` (`:34/:92-158/:192-198/:221`, con l'import nel vault rimosso);
  - `VaultSetup.tsx`, `VaultUnlock.tsx`;
  - `AppLayout`: banner non chiudibile per `openRecovery` e `RESET_PENDING`, letto da `GET /vault/keyring` all'avvio, al focus e ogni 15 minuti (§3.2.2);
  - `CredentialForm.tsx`, `CredentialCard.tsx:17`, `credentialTypes.ts:21-33`;
  - `NoteEditor.tsx` + `useNoteController`: prop `vaultCodec` per titolo e contenuto; per le note vault nascondere condivisione, AI, versioni e allegati.
- **i18n:** chiavi `vault.*` in **en.json e it.json**, sempre in coppia. Tutta la nuova UI ha varianti `dark:`, touch target da 44px, bottom sheet su mobile.

### 7.4 File TIER toccati

| TIER | File | Modifica |
|---|---|---|
| 1 | `backend/prisma/schema.prisma` | Modelli + 1 migration nuova |
| 1 | `frontend/src/store/vaultStore.ts` | Campi persistiti additivi, VK in memoria |
| 1 | `frontend/src/features/sync/syncService.ts` | Solo push latest-state per le note vault (`~:755-771`) + `vaultBaseHash` su 200 |
| 1 | `backend/src/hocuspocus.ts` | `onAuthenticate` + guardia in `store()` + disconnect al passaggio nel vault |
| 1 | `frontend/src/lib/db.ts` | **Solo il tipo** `vaultBaseHash?` in `LocalNote`, **nessuna** nuova versione |
| 1 | `frontend/src/utils/crypto.ts` | **Non toccato** |
| 2 | `frontend/src/store/authStore.ts` | `:76` → `lockVault()` |
| 2 | `backend/src/app.ts` | Registrazione route (`vault.ts`, `vaultAdmin.ts`), controllo pepper al boot, controllo del file root (warning, non fatale), job purge reset e scadenze delle richieste |
| 2 | `backend/src/services/email.service.ts` | Template: richiesta di recupero, metà B del codice, attesa 72h con "Annulla", promemoria, rilascio, completamento, rigenerazione Kit, reset, lockout; errori passphrase ai SUPERADMIN |
| 2 | `api.ts`, `Editor.tsx`, `auth.service.ts` | **Non toccati** (allegati bloccati a livello `NoteEditor`; in P2 verificare che paste/drop immagini in `Editor.tsx` non lo aggirino, altrimenti serve una guardia TIER 2) |

Ogni file TIER richiede "proponi prima", il gate e reviewer + red-team.

---

## 8. Fasi di consegna

### P0: hotfix (senza crittografia né schema), rilasciabile subito

- **Scope:**
  - placeholder in sola lettura + fetch pigro (§6.1.1);
  - guardie server: Hocuspocus `isVault` (`onAuthenticate` + `store`), sharing `isVault`, search/AI `isVault`;
  - testo del reset onesto ("dimentica solo il PIN su questo dispositivo").
- **Criteri di accettazione:**
  - su un secondo contesto la credenziale mostra la copia del server, oppure offline un placeholder non modificabile; il contenuto sul server non viene mai sovrascritto;
  - una nota spostata nel vault è assente da `/api/search` e rifiutata dall'AI;
  - una connessione WS verso una nota vault viene rifiutata; lo share di una nota vault risponde 400;
  - `npx tsc -p tsconfig.app.json --noEmit`, lint e vitest verdi.
- **Test:**
  - unit: `CredentialForm` con `''` non chiama mai `updateNote`;
  - backend: search esclude `isVault`, hocuspocus rifiuta, `shareNote` rifiuta;
  - e2e: `frontend/e2e/vault-overwrite.spec.ts` (2 contesti).

#### §8 P0 — limiti noti fino a P2

Il hotfix P0 non chiude questi casi; restano aperti fino a P2 (i primi due, fino al compare-and-swap lato server, che li chiude entrambi; gli ultimi due vengono chiusi o rivisti in P2).

- **Copia locale obsoleta ma non vuota (offline oppure online):** il hotfix P0 reidrata solo le voci con contenuto locale vuoto. Una voce con contenuto locale non vuoto ma più vecchio della copia del server si apre subito, senza confronto con il server, ed è modificabile; il push successivo può sovrascrivere la copia più recente del server. Vale sia offline sia online, e anche per una voce già aperta mentre un altro dispositivo la modifica. Si chiude solo con il compare-and-swap lato server di P2.
- **Bundle PWA vecchio in cache (precedente alla 1.12.2):** finché non si ricarica, può ancora sovrascrivere una credenziale breve. Misurato: il testo cifrato di una `EMPTY_CREDENTIAL` è lungo 124-152 caratteri, contro la guardia server a 150 caratteri, quindi una parte dei casi passa sotto la guardia.
- **Nota condivisa spostata nel vault:** le modifiche collaborative degli ultimi ~2 s (debounce di Hocuspocus) possono non essere salvate, perché le connessioni vengono chiuse subito.
- **Nota "sicura" (`isEncrypted`) uscita dal vault:** non torna nella ricerca, perché `searchText` non viene ricalcolato per le note `isEncrypted`.

### P1: fondazioni server + cerimonia root (nessun cambio UX)

- **Scope:**
  - `npm run vault:root-keygen` sul server (file root cifrato con la passphrase + copia offline cifrata), chiavi pubbliche fissate nel bundle e nel backend, `VAULT_PEPPER_KEY`;
  - migration, `vault.ts` + service + Zod;
  - imposizione envelope/CAS e bypass chiusi (restore, `updateSharedNoteContent`, import, allegati), attivi **solo con keyring READY**.
- **Criteri di accettazione:**
  - `migrate deploy` segnala esattamente 1 migration pending e `migrate status` è pulito;
  - due `POST /keyring` concorrenti danno 201 + 409;
  - `GET /keyring` risponde sempre 200;
  - 5 `unlock` sbagliati non bloccano; il 6° imposta `lockedUntil` (15m, poi 1h, poi 24h), scrive una riga di audit e manda l'email; uno sblocco riuscito azzera il contatore;
  - senza keyring le scritture legacy passano ancora;
  - con keyring: plaintext → 422, `baseHash` sbagliato → 422 conflict, epoch vecchia → 422 stale;
  - `finalize` rifiuta gli id non-envelope;
  - `cd backend && npm test` verde.
- **Test:** `vault.service.test.ts` (409, lockout al 6° errore e backoff, HMAC con pepper, CAS su `rev`, `vkProof`: firma valida accettata; firma su un altro path, un altro `rev` o un `payload` modificato → 403; **replay** della stessa richiesta firmata dopo il successo → 409); `vaultRootKeygen` produce un file che si riapre solo con la passphrase giusta; test di `note.service` su envelope, CAS e transazione di spostamento nel vault; restore e `updateSharedNoteContent` rifiutati.

### P2: client E2EE + migrazione + multi-dispositivo (un solo rilascio)

- **Scope:**
  - `vaultCrypto` (Argon2id in un worker), stato UNKNOWN/NONE/READY, setup con Kit dopo il 201, sblocco online/offline;
  - policy del PIN (6 caratteri alfanumerici case-sensitive, lettera + cifra, blocklist); cerimonia del Kit (PDF/copia + 2 gruppi a caso); rigenerazione del Kit dalle impostazioni; interruttore "sblocco offline" per dispositivo;
  - logout → lock; envelope per note, credenziali e titoli; idratazione; push latest-state; copie in conflitto;
  - wizard di migrazione + `finalize`; spostamento dentro e fuori dal vault; cambio PIN (+ rotazione VK facoltativa).
- **Criteri di accettazione:**
  - `SELECT content FROM "Note" WHERE "isVault"` restituisce solo `^nv3\.` (più le credenziali legacy bloccate, elencate) e `title=''`;
  - dopo `finalize` nessuna NoteVersion vault non-envelope; `searchText` e `ydocState` a NULL;
  - il dispositivo B chiede il PIN, non il setup, e decifra;
  - i PIN `123456`, `abcdef`, di 5/7 caratteri, `Marco1`, `2024ab`, `qwer12`, `a1a1a1` sono rifiutati; `k7Rq2x` è accettato e `K7rQ2X` non sblocca (case-sensitive);
  - il Kit compare solo dopo il 201 e una sola volta; senza riscrivere correttamente i 2 gruppi il setup non si chiude; i 2 caratteri di controllo rilevano un errore di battitura;
  - rigenerare il Kit a vault sbloccato invalida il vecchio (escrow nuovo, verificato sul DB); a vault bloccato l'azione non c'è;
  - con "sblocco offline" disattivato il dispositivo non ha `wrappedVkPin`/`serverShare` in cache e offline mostra l'avviso;
  - logout → login porta allo sblocco, non al setup;
  - offline con cache: lo sblocco funziona; senza cache: avviso, mai il setup;
  - `kdfParams` manomessi → lo sblocco fallisce;
  - 3 edit offline della stessa nota con un riferimento in coda producono **0** conflitti falsi;
  - un edit concorrente reale produce 1 copia in conflitto e nessuna perdita;
  - un utente legacy seed (note in chiaro + credenziale v2 + credenziale legacy) si migra con valori identici;
  - un item con PIN sconosciuto resta byte-identico;
  - migrazione da 2 dispositivi: 1 keyring, nessuna perdita;
  - un bundle vecchio che scrive plaintext dopo il keyring produce 1 copia in conflitto al primo avvio del bundle nuovo.
- **Test:**
  - unit: `vaultCrypto.test.ts` (known-answer Argon2id/HKDF, roundtrip, AAD swap, minimo dei parametri, check char del Kit), `PinPolicy.test.ts` (solo cifre / solo lettere / lunghezza / blocklist), `vaultStore.test.ts` (chiave invariata, `partialize` additivo), test della push latest-state;
  - e2e: `vault-kit.spec.ts` (cerimonia + rigenerazione);
  - e2e: `vault-multidevice.spec.ts`, `vault-offline.spec.ts` (`context.setOffline`), `vault-migration.spec.ts` (dati legacy seed + verifica sul DB), `vault-conflict.spec.ts`;
  - da rilanciare: `offline-first`, `dexie`, `encryption`, `notes`, `collaboration` (`:249` è instabile: confermarlo con `git stash`).

### P3: reset reale

- **Criteri di accettazione:**
  - codice o password sbagliati non cancellano nulla; il 6° tentativo è rifiutato; il codice scade a 10 minuti;
  - `RESET_PENDING` blocca subito sblocco e scritture; annullare ripristina tutto;
  - dopo il job: 0 note, tag, versioni e righe allegato vault, file eliminati, epoch+1, riga keyring presente;
  - il dispositivo B pulisce solo con uno stato esplicito, e un 404 simulato non cancella nulla;
  - le scritture in coda di B finiscono `failed` e non risorgono.
- **Test:** transazione di reset e scheduling del job lato backend; e2e `vault-reset.spec.ts` (2 contesti + route 404 simulata).

### P4: recupero root (informatizzato)

- **Scope:** `vaultRecovery.service`, route utente e `vaultAdmin.ts`, `vaultRootKey.service`, tab admin "Recupero vault", `VaultRecovery.tsx` + `RecoveryCodeForm.tsx`, notifiche `VAULT_RECOVERY`, email, job delle scadenze.
- **Criteri di accettazione:**
  - una richiesta nasce `PENDING_APPROVAL`; senza approvazione non parte nessun codice; dopo 7 giorni va in `EXPIRED`;
  - all'approvazione la metà A arriva **solo** come notifica cifrata: il dispositivo richiedente la mostra, un secondo contesto dello stesso utente vede la notifica ma non il codice; la metà B arriva solo per email; nel DB ci sono solo gli HMAC;
  - `confirm` con una metà sbagliata fallisce; al 5° errore o dopo 24 ore la richiesta è `EXPIRED`;
  - dopo `confirm`: `WAITING`, `notBefore = now+72h`, email + notifica a tutte le sessioni; `DELETE` da un'altra sessione → `CANCELLED` e il rilascio è rifiutato;
  - release prima di `notBefore` o in uno stato diverso da `WAITING` → 4xx; passphrase sbagliata → 4xx, audit, email ai SUPERADMIN; 4° tentativo in 15 minuti → 429;
  - dopo il release nessun file, riga di DB o log contiene la chiave root in chiaro o la passphrase (grep dei log del test); `rootShareForClient` scade dopo 7 giorni;
  - firma non valida o `FP` firmato diverso da quello del dispositivo → il client rifiuta;
  - senza Kit fallisce; con Kit recupera VK e forza nuovo PIN e nuovo Kit; il vecchio Kit non funziona più;
  - catena `AuditLog` completa; `rootShareForClient` NULL dopo il completamento; la chiave effimera sparisce da `notiq-vault-device`;
  - con una richiesta aperta, `DELETE /api/notifications/all` non rimuove le notifiche `VAULT_RECOVERY`, e il banner (da `openRecovery`) compare in un secondo contesto anche con 0 notifiche;
  - il nuovo Kit si vede **prima** di `complete`; una `complete` interrotta dopo il commit e ripresa al reload (stesso `payload`) → 200 e nessun Kit rigenerato;
  - `DELETE` e `release` concorrenti: esattamente una delle due riesce, l'altra riceve 409; 10 `confirm` in parallelo producono al massimo 5 tentativi contati;
  - i contatori della passphrase sopravvivono al restart del processo; gli errori di un admin non bloccano un secondo `SUPERADMIN`;
  - 3 richieste annullate dalla vittima non impediscono una quarta;
  - con due `rootKeyId` nel file, un keyring sigillato col vecchio id si recupera.
- **Test:**
  - backend: `vaultRecovery.service.test.ts` (macchina a stati, rate limit, tempi con clock finto, HMAC delle metà, 5 tentativi, annullamento da un'altra sessione); `vaultRootKey.service.test.ts` con una chiave di test (passphrase giusta e sbagliata, seal verso `clientEphPub`, firma verificabile, passphrase assente dai log grazie a `redact`);
  - e2e: `vault-recovery.spec.ts` (utente e admin in due contesti, clock avanzato oltre le 72 ore, metà B letta dalla mailbox di test) con un `rootKeyId` solo di test, **mai** incluso nel bundle di prod.

### P5: rifinitura

- **Scope:** viewer delle versioni che decifra, rotazione della chiave root con re-seal al prossimo sblocco tramite `userShareUnderVk` (la chiave vecchia resta nel file finché un keyring la usa, §2.2), runbook di purge dei backup, drill, manifest di release firmato + `verify-prod-bundle.mjs` (§7.2).
- **Criteri di accettazione:** il restore di una versione vault si decifra; la rotazione root non chiede un nuovo Kit; un utente che dimentica il PIN prima del re-seal si recupera con la chiave vecchia; la chiave vecchia esce dal file solo con 0 keyring che la usano; `verify-prod-bundle.mjs` segnala un asset modificato sul server.

---

## 9. Rischi residui

1. **Tetto dell'E2EE web: l'operatore può sempre modificare il client.** Chi controlla l'origin (operatore, root o un attaccante su IIS) serve **una volta** un bundle o un `sw.js` modificato. Il service worker lo mette in cache, e al successivo sblocco il PIN esce, oppure esce il Kit durante un recupero (§3.2.7). Questo aggira **ogni** controllo di §3, Kit e firma root compresi, perché anche il codice che verifica la firma arriva dall'origin. Una PWA non ha pinning del bundle, quindi **in una web app non si chiude**. Il requisito "root mai da solo" va letto con questa riserva scritta accanto (§1, §3.5.5). Mitigazioni, che **rilevano e non impediscono**: manifest di release firmato con una chiave fuori dal server + hash pubblicati nel tag + `verify-prod-bundle.mjs` da una macchina esterna (§7.2, P5); frase esplicita nella UI. Per chiuderlo davvero servirebbe un client installato e firmato (estensione o app nativa), fuori scope.
2. **Operatore con DB + pepper: arriva prima o poi al PIN.** `authVerifier`/`serverShareEnc` + `wrappedVkPin` gli danno un oracolo locale. Con 6 caratteri alfanumerici esaurire lo spazio costa al massimo ~1,2 GPU-anni per utente (~9 giorni con 50 GPU) e **giorni per i PIN "umani"** (`Marco1`, `2024ab`), anche con il filtro di §2.2. Il requisito "root mai da solo" **non vale** contro chi ha DB + pepper: vale solo per la procedura di recupero. È una conseguenza diretta del PIN di 6 caratteri (§10.1). La si attenua alzando i parametri Argon2id se l'iPhone li regge (§2.2) e con il filtro dei PIN prevedibili; la si elimina solo con un segreto più lungo o con WebAuthn PRF (evoluzione futura).
3. **Furto del dispositivo con cache offline**: è il **rischio residuo principale**. Stesso brute force offline, senza lockout, perché la chiave "non-extractable" è comunque su disco. Mitigazioni: sblocco offline disattivabile per dispositivo, "Ruota anche la chiave del vault" dopo il furto (§5.3), cifratura del disco del dispositivo (fuori dal nostro controllo).
4. **Perdita di `VAULT_PEPPER_KEY`**: sblocco impossibile per tutti; resta solo il recupero con Kit + root. Serve un backup offline separato.
5. **Perdita della chiave root o della passphrase**: niente più recupero per nessuno (il vault resta sbloccabile col PIN). Servono la copia offline cifrata del file e il drill trimestrale.
6. **Chiave root sul server cifrata con passphrase**: un attaccante che controlla il server **nel momento** in cui root digita la passphrase (o registra il traffico dopo TLS, o legge la memoria del processo) ottiene la chiave root e quindi `S_root` di tutti gli utenti. Non basta: gli serve anche il Kit di ciascun utente. Mitigazioni: passphrase lunga + Argon2id 256 MiB sul file, rilasci rari, alert email a tutti i SUPERADMIN su ogni errore di passphrase, rotazione della chiave root (P5) dopo un sospetto di compromissione.
7. **Email + sessione compromesse**: l'attaccante può chiedere il recupero e superare il codice A/B. Lo coprono il **Kit** (senza il quale il rilascio è inutile) e la **finestra di 72 ore** con notifica e "Annulla" su tutte le sessioni.
8. **Kit + PIN persi**: vault irrecuperabile, per scelta. Resta solo il reset.
9. **Credenziali legacy** cifrate con un PIN dimenticato: restano illeggibili, elencate, mai cancellate.
10. **Plaintext storico** in `pg_dump`, ZIP e WAL fino alla rotazione. Utenti che non aprono mai il vault: restano in chiaro sul server. Lo stesso vale per gli snapshot NoteVersion di una migrazione interrotta, finché l'utente non sblocca di nuovo: la ripresa è automatica e c'è l'elenco admin dopo 7 giorni (§6.2.8), ma il server non può cancellarli senza la verifica del client.
11. **Metadati visibili al server**: nomi dei tag vault (decisione §10.6), `noteType`, timestamp, conteggi, richiesta di screenshot `siteUrl` (`CredentialForm.tsx:129`), favicon DuckDuckGo (`:23`).
12. **Dipendenza nuova `hash-wasm`** (anche nel backend, per la passphrase root): tempo e memoria su iOS PWA da misurare in P2; `kdfParams` resta calibrabile, ma solo verso l'alto.
13. **Push latest-state in `syncService`**: è l'unico punto TIER 1 del sync. Va verificato che nessun altro percorso scriva `content` delle note vault fuori da `updateNote`.
14. **DoS dello sblocco online**: con un JWT rubato qualcuno può innescare il lockout. È limitato nel tempo, lo sblocco offline resta disponibile e l'utente riceve un'email.
15. **Vittima assente per 72 ore**: se non apre l'app su nessun dispositivo e non legge la posta, il banner e le email non la raggiungono. Contro un attaccante con mailbox + JWT resta solo il Kit (§3.2.5).
16. **Filtro dei PIN solo lato client**: il server non vede il PIN, quindi non può imporre il filtro. Un client modificato, o un utente ostinato con un PIN non in lista ma comunque prevedibile, lo supera. Attenua §9.2, non lo chiude.

### Tracciabilità dei finding del red team

| Finding | Correzione |
|---|---|
| Hocuspocus `store()` scrive plaintext dopo lo spostamento nel vault | Guardia in `store()` + `onAuthenticate` + disconnect + `ydocState=null` (§6.4, §7.2) |
| Epoch solo in AuditLog | Epoch sulla riga `VaultKeyring`, mai cancellata (§4) |
| 404 nudo → purge | `GET` sempre 200; purge solo su stato esplicito; 404 = UNKNOWN (§4.5) |
| Cache offline brute-forzabile | Rischio dichiarato + opzione per disattivarla + PIN alfanumerico con costo stimato (§2.4, §5.2, §9) |
| Purge delle versioni senza prova | Snapshot forzato + `finalize` dopo la verifica dei byte del server (§6.2) |
| Swap di `clientEphPub` | `FP` nella firma ECDSA + verifica client dell'`FP` firmato; la metà A è cifrata per `clientEphPub`; lo swap comunque non dà `S_user` (§3.2, §3.5) |
| `PUT` con `authKeyOld` blocca il recupero | `vkProof` per tutte le mutazioni del keyring (§3.2, §7.2) |
| Catena `baseHash` rotta dal riordino | Push latest-state + `vaultBaseHash` in Dexie (§5.3) |
| Restore e `updateSharedNoteContent` aggirano i controlli | Guardie dedicate (§7.2) |
| Root decifra da solo con brute force del PIN | Pepper + PIN alfanumerico + Argon2id; costo e limite dichiarati (§2.3, §2.4, §9) |
| Migrazione che cifra una copia locale vecchia | Sorgente = server dopo il flush (§6.2) |
| Reset e `PUT` protetti solo dal JWT | Reset: codice + password dell'account + finestra di 7 giorni. `PUT`/complete: `vkProof` (§4, §7.2) |
| Il perdente del setup concorrente vede un Kit non valido | Kit mostrato solo dopo il 201 (§3.2) |
| Titoli in chiaro | Titolo nell'envelope da P2 (§2.2) |
| `''` come sentinella rende note vuote non modificabili | Item sempre envelope (§6.1) |
| U incapsulato con la password dell'account (ux-ops) | Non adottato: `S_user` esiste solo nel Kit |
| Numero di richiamo modificabile | Superato: niente richiamo telefonico; identità verificata con codice A (solo sul dispositivo richiedente) + B (email) + 72 ore annullabili (§3.2) |
| Bundle vecchio perde gli edit dopo la migrazione | 422 terminale + conversione in copia in conflitto (§6.3) |
| Il cambio PIN non revoca i dispositivi rubati | Opzione "ruota la chiave del vault" (§5.3) |
| Paste disabilitato nel reset | Paste permesso (§4.2) |
| `pinHash` persistito per sempre | Azzerato a migrazione completata (§6.2.7) |
| **Round 3.** FATAL: root con DB + pepper forza il PIN offline, quindi "root mai da solo" è falso | **Residuo dichiarato**, non chiudibile con 6 caratteri: requisito riformulato ("solo per la procedura") in §1, §2.3, §3.5.5, §10.1; costi ricalcolati (≈1,2 GPU-anni, giorni per PIN umani); filtro dei PIN prevedibili (anni, date, camminate di tastiera, nomi + cifre) in §2.2; Argon2id alzabile solo se l'iPhone regge (§2.2, da riconfermare con l'utente); frase nella UI; §9.2, §9.16 |
| **Round 3.** FATAL: bundle/SW manomesso cattura PIN e Kit | **Residuo dichiarato**, non chiudibile in una PWA: riga "l'operatore può sempre modificare il client" accanto al requisito (§1, §3.5.5) e nella UI; manifest di release firmato fuori dal server + `verify-prod-bundle.mjs` esterno, che rileva e non impedisce (§7.2, P5, §9.1) |
| **Round 3.** Notifiche ed email cancellabili con un JWT rubato → "Annulla" non arriva | `openRecovery` in `GET /vault/keyring` + banner non chiudibile in `AppLayout`; `VAULT_RECOVERY` escluso da delete/read-all mentre la richiesta è aperta (§3.2.2, §3.2.5, §7.2); residuo per la vittima assente 72h (§9.15) |
| **Round 3.** `vkProof` non definito, di fatto era il bearer statico `vkAuth` → replay distruttivo | `vkProof` = firma ECDSA P-256 con `vkSigKey` sbustata da VK, su metodo + path + userId + epoch + `rev` + sha256(`payload`); il server conserva solo `vkSigPub`, CAS su `rev` = niente replay; `vkAuth`/`vkVerifier` rimossi (§2.1, §7.1, §7.2, test P1) |
| **Round 3.** Rotazione della chiave root → vault irrecuperabile prima del re-seal | Il file root tiene tutte le coppie `rootKeyId` ancora referenziate; il rilascio usa il `rootKeyId` del keyring; rimozione solo con count = 0 (§2.1, §2.2, §3.2.6, §7.1, P5) |
| **Round 3.** Risposta di `complete` persa → Kit nuovo mai visto, Kit vecchio morto | Nuovo Kit mostrato **prima** di `complete`; `payload` pendente salvato in `notiq-vault-device`; `complete` idempotente con `completedPayloadHash`; lo stesso schema vale per la rigenerazione del Kit (§3.2.7, §7.1, §7.2) |
| **Round 3.** Contatori della passphrase in memoria (azzerati dal restart pm2) e blocco globale causato da un co-admin | Contatori da righe `AuditLog` scritte in modo sincrono, **per admin**; blocco di 24h solo per quell'admin (§3.3, §7.2) |
| **Round 3.** 3 richieste/30gg consumate dall'attaccante | Non si contano le `CANCELLED`/`REJECTED` (§3.3, §7.2) |
| **Round 3.** Transizioni read-then-write (cancel vs release, confirm concorrenti) | Ogni transizione è `updateMany` con lo stato atteso, e `count !== 1` → 409; `attempts` incrementato prima del confronto (§3.2.6, §3.3) |
| **Round 3.** Snapshot in chiaro di una migrazione interrotta restano per sempre | Ripresa automatica di verifica + `finalize` a ogni sblocco `IN_PROGRESS`; elenco admin + email dopo 7 giorni; residuo finché l'utente non sblocca (§6.2.8, §9.10) |

---

## 10. Decisioni prese (2026-09-30)

1. **Segreto del vault = PIN di 6 caratteri**, alfanumerico, **case-sensitive**, con almeno 1 lettera **e** 1 cifra (solo cifre rifiutato). Niente password di 10 caratteri. Restano Argon2id m=64 MiB, t=3, p=1, pepper lato server + `serverShare`, lockout online al 6° errore. **Sblocco offline attivo di default**, disattivabile per dispositivo. Costi dichiarati: ~5,7·10¹⁰ combinazioni, ~1000 tentativi/s per GPU di fascia alta → ordine di 1–2 GPU-anni con DB + pepper o con un dispositivo rubato (precisato in §2.4: ≈1,2 GPU-anni per le combinazioni valide, giorni per i PIN "umani"; con DB + pepper root arriva prima o poi al contenuto, §9.2); a sole cifre sarebbero minuti. Il furto del dispositivo con cache offline resta il rischio residuo principale (§2.2, §2.4, §9).
2. **Il Recovery Kit vale solo insieme a root (2-di-2).** Nessun auto-recupero con il solo Kit in questa versione.
3. **Kit + PIN persi insieme = vault irrecuperabile.** Resta solo il reset.
4. **Recupero interamente informatizzato** (§3): niente richiamo telefonico, carta, USB o macchina air-gapped.
   - (a) richiesta dall'app con chiave ECDH effimera non-extractable legata al dispositivo;
   - (b) **approvazione di root** nel pannello admin;
   - (c) codice monouso in due metà: **A** solo come notifica in-app al dispositivo richiedente (cifrata per la sua chiave), **B** per email; l'utente le digita entrambe in un form dedicato;
   - (d) **72 ore** di attesa con email + notifica a tutte le sessioni ("Non sei tu? Annulla"), annullabile da qualsiasi sessione;
   - (e) dopo le 72 ore root rilascia la sua quota digitando la **root passphrase** nel pannello admin: la chiave privata root sta **sul server cifrata con la passphrase**, si decifra solo in memoria, non viene mai persistita in chiaro; il rilascio è firmato e sigillato alla chiave effimera del dispositivo;
   - (f) l'utente inserisce il Kit, imposta un nuovo PIN, riceve un nuovo Kit; il vecchio Kit non vale più.
   - Una **copia offline cifrata** del file della chiave root (compito ops una tantum).
   - **Recovery Kit**: 32 caratteri Crockford + 2 di controllo, mostrato una sola volta dopo la creazione del keyring, con download PDF e copia, e conferma riscrivendo 2 gruppi a caso; rigenerabile dalle impostazioni del vault finché si conosce il PIN.
5. **Reset con finestra di 7 giorni annullabile** (codice di sistema da digitare, stile GitHub, + password dell'account). Il vault resta subito bloccato e nascosto.
6. **Allegati e import bloccati nelle note vault; nomi dei tag vault in chiaro sul server** (documentato, §9). Gli allegati cifrati diventano una feature separata.
