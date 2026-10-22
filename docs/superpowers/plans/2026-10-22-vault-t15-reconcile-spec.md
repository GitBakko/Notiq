# Specifica del modello del reconcile vault (T15), revisione 2 (22/10)

Prodotta da architect, attaccata da reviewer e red-team, rivista. Prevale sulle sezioni 5.6 e 5.8 del piano P2 per tutto quello che riguarda il reconcile. Fonte delle decisioni di T15; i finding sono nella tabella (b).

## (a) Specifica v2

**1. Approccio**
- **Scelto.** `decide(snapshot)` pura, poi `prepare` (crypto fuori dalla transazione), poi `commit` in una sola transazione Dexie per nota, sotto il Web Lock della nota. Copia e adozione stanno nella stessa transazione.
- **Stato del server.**
  - Il listing completo paginato di oggi resta. Serve a T1, a legacyLeft e a finalize.
  - I candidati assenti dal listing si chiedono con `POST /vault/items {ids}`, esteso con `absent` e `notVault`.
  - Fuori dal listing non vuol dire S0: getItems filtra `isVault:true`.
- **Respinto:** altre patch su seme, heartbeat e id deterministico. Tre giri di review hanno dato ogni volta MAJOR nuovi.

**Assi**
- **S** (solo da risposta 200): S0 assente, SN non vault, SE envelope dell'epoch corrente (Hs), SX altro epoch, SL vault legacy. S? = rete/5xx/429, mai "assente".
- **L:** L0, LS, LD, LV, LP come in v1. LN si divide in LNp (content non envelope) e LNe (content envelope; nasce solo senza `navigator.locks`).
- **Q, O, K, H, U, P:** come in v1.
- **Z (nuovo):** `row.userId === ctx.userId && row.ownership !== 'shared'`, e `item.userId === ctx.userId`.

**Precondizioni** (vince la prima)
1. ¬Z: NONE, la riga non si tocca mai.
2. K assente: SKIP del giro.
3. QD: NONE.
4. Lock della nota non ottenuto: LATER.
5. locks assente: solo REQUEUE e finalize.
6. S?: LATER.
7. Snapshot cambiato: LATER. Lo snapshot contiene content, updatedAt, syncStatus, isVault, e id/data/**status** degli item.
8. Decrypt o round-trip fallito, oppure copia oltre 2 MiB: LEAVE(motivo), riga e coda intatte.

**Ordine di valutazione:** precondizioni, poi LN (T12-T14), poi SX/SL (T8/T7), poi LP (T6), poi Q (T2-T5, T9-T10), infine T1.
Qf "altro" (validation/not_found/forbidden/network) su riga non LP: NONE, lo gestisce `retryFailedSyncItems`.

**Tabella dei casi**
- **T1** SE, LS/LV, Q0 (le righe vengono dal listing completo). Hs≠base: HYDRATE (riga=server, base=Hs, sent=[]). Hs==base: NONE.
- **T2** SE, Qf:conflict, Hs==sha(L) o Hs∈sent: ACK. Base=Hs, item pending, 0 copie.
- **T3** SE, Qf:conflict.
  - Hs==base: REQUEUE con 0 copie. La PUT era partita con una base vecchia da un'altra scheda.
  - Hs diverso: COPY(P)+ADOPT(SE).
- **T4** SE, LD, Q0. Hs==sha(L): synced, base=Hs. Hs==base: accoda UPDATE{content}. Altrimenti COPY+ADOPT.
- **T5** SE, riga envelope corrente, Qp o Qf vault:* non conflict: STRIP+REQUEUE.
  - UPDATE: si tolgono title, `isEncrypted:false` e isVault.
  - CREATE = `{...item.data, title:'', content: riga, isEncrypted:true, isVault:true}`. È un override: id, notebookId e noteType restano (noteType è nell'AAD).
  - Item vuoto: delete. Epoch vecchio: LEAVE(epoch).
- **T6** SE, LP.
  - P=={t,c} del server: ADOPT.
  - Riga envelope con soli item-titolo: REENCRYPT con il t nuovo. Nella stessa transazione: `syncStatus:'updated'` e UPDATE{content} accodato, base invariata.
  - Content in chiaro stantio su riga envelope: STRIP.
  - Altri casi: COPY(P)+ADOPT.
  - P non decifrabile: LEAVE(legacyPin), va a T20.
- **T7** SL. P==server: STRIP degli item, riga al wizard (legacyLeft). P≠server: COPY(P)+ADOPT_SL.
- **T8** SX: LEAVE(epoch), va a P3.
- **T9** S0, U, con CREATE.
  - LP: REENCRYPT sul posto e CREATE rinfrescata (override come T5).
  - CREATE già canonica e pending: NONE. Non si conta, attempts e backoff restano.
  - Altrimenti: rinfresco + REQUEUE.
- **T10** S0, U, senza CREATE: COPY(P)+DROP. S0 senza U: DROP.
- **T11** SN, riga vault. Con U: COPY(P)+DROP. Senza U: DROP.
- **T12** LN+SE: COPY(enc{row.title, plaintext; per LNe si decifra prima})+ADOPT con isVault/isEncrypted true e title ''.
- **T13** LN+SN e LN+S0.
  - LNp+SN: si tolgono i campi vault, `lastError:null`, pending. Diventa un item normale: vince l'ultimo che scrive, come per ogni nota normale.
  - LNe+SN: COPY(decrypt) nel vault + DROP.
  - LNp+S0 con U: COPY in chiaro non vault (senza crypto) + DROP.
  - LNe+S0: COPY vault + DROP.
  - LN+S0 senza U: DROP.
- **T14** LN+SL: LEAVE(legacyLeft). Dopo T20 diventa SE e si risolve con T12. LN+SX: LEAVE(epoch).
- **T15** L0 senza item: NONE. L0 con item vault:*: U dà COPY(P dall'item)+DROP item; senza U, DROP item.

**Completezza** (S×L dopo le precondizioni)
- SE: L0=T15, LS/LV/LD=T1-T5, LP=T6, LN=T12.
- SX: T8 (LN: T14).
- SL: T7 (LN: T14).
- S0: T9/T10 (LN: T13).
- SN: T11 (LN: T13).
- L0: T15 per ogni S.

**Lock**
- **Per nota:** `notiq-vault-note:<id>`, come in v1. T18 lo chiede in attesa, il reconcile con `ifAvailable`.
- **Giro:** `notiq-vault-reconcile` in modo **attesa** per tutti i chiamanti. La single-flight per scheda tiene al massimo 1 giro in volo e 1 in coda.
- **decryptLegacy:** passa un `signal`. Su abort il risultato è `skipped:'busy'` e T20 mostra "riprova". `ReconcileResult.skipped` aggiunge `'busy'`.
- Così il trigger di T18 non si perde e il giro di T20 non trova un'altra scheda senza callback.

**Pull (c), TIER 1**
- Le righe con `existing.isVault !== n.isVault` escono dal bulkPut.
- Dopo la transazione, per ognuna: `withNoteLock(id, ..., {ifAvailable})`, rilettura, poi scrittura solo se ancora synced e ancora flip. Si scrive `content: n.content ?? ''`, senza base e senza sent.
- Lock occupato: la riga si salta e la prossima pull riprova. locks assente: scrittura diretta.

**Copia e hash inviati**
- Come v1 (id con `randomUUID` dentro la transazione dell'adozione; aggiunta atomica a vaultSentHashes).
- `sentHash` va dichiarato fuori dal blocco (`syncService.ts:1012`) e usato a :1169 sia per CREATE sia per UPDATE.
- Rimozione: `slice(indexOf+1)`. Con -1 dà `slice(0)`, cioè la lista resta intatta.

**2. File**
- **Frontend:** come v1 (`vaultReconcile.ts`, `vaultCodec.ts`, nuovo `lib/vaultNoteLock.ts`, `vaultApi.ts`), più:
  - In run: candidati filtrati con Z.
  - Tipo `'busy'` in ReconcileResult.
  - `vaultNoteLock.ts` lo usa anche `syncService.ts`.
- **syncService.ts:** (a) aggiunta atomica; (b) hoist di sentHash e rimozione a prefisso; (c) flip con lock come sopra.
- **Backend:** `vault.service.ts` (getItems con ids, absent/notVault) e `note.service.ts`: 422 `errors.vault.plaintextRequired` nei 3 punti di v1.

**3. Invarianti**
- I1, I3, I4, I5, I6: come v1.
- **I2, ristretto.** Il reconcile non tocca una riga col lock tenuto. La pull non cambia isVault di una riga col lock tenuto. Le altre scritture della pull sotto un editor aperto finiscono nel CAS e poi in T3: nessuna perdita. Una PUT envelope su nota non vault prende 422.
- **I7, nuovo.** Righe e item di un altro userId, o shared, non si toccano mai.

**4. Accettazione**
- **Comandi:**
  - `cd frontend; npx vitest run src/lib/__tests__/vaultReconcile.test.ts src/features/sync/__tests__/syncService.vault.test.ts`
  - `npx tsc -p tsconfig.app.json --noEmit` a 0
  - `cd backend; npx vitest run src/services/__tests__/vault.service.test.ts` più i test di note.service
- **Test esistenti:** liste di v1. Il test 765 va **sostituito**: con T5 l'UPDATE si ripulisce e si riaccoda, non si rifiuta.
- **Test nuovi:**
  - un test di decide() per T1-T15 e per ogni precondizione;
  - LN in tutte le combinazioni: LNp/LNe × SN/S0/SL/SX;
  - riga LP di un altro userId non toccata;
  - CREDENTIAL con CREATE vault:stale: noteType conservato;
  - item solo-titolo: dopo il giro esiste un UPDATE{content};
  - T3 con Hs==base: pending, 0 copie;
  - T9 canonica: secondo giro tutto a 0;
  - due schede: busy, poi il secondo giro parte; decryptLegacy con l'altra scheda occupata;
  - flip della pull sotto lock tenuto: riga intatta, applicato alla pull dopo il rilascio;
  - sentHash per CREATE;
  - status dell'item cambiato fra decide e commit: LATER.
- **E2E:** "spostata fuori su B" verifica la nota in chiaro aprendola **online**.

**5. Rischi**
- Con K assente, LNp resta bloccato fino allo sblocco del vault. Non è "per sempre": I4 regge.
- Una scheda iOS sospesa trattiene i lock: i giri aspettano, T20 usa signal e "riprova".
- Un editor aperto su una nota spostata fuori altrove continua a scrivere fino all'unmount, e ne esce una copia. Il liveQuery di T18 è respinto per scope.
- GET /notes non porta content: una nota spostata fuori è vuota offline finché non si apre online. È il backlog noto.
- Non verificato:
  - `POST /vault/items` con vault bloccato lato server;
  - se una PUT con 404 scarta l'UPDATE;
  - il codice di T18, che non esiste ancora.

## (b) Finding e decisioni

| Finding | Decisione |
|---|---|
| R-MAJOR LN senza SN/S0/SL/SX | Accettato, con la distinzione LNp/LNe: righe T13 e T14 |
| R-MAJOR candidati senza listing completo | Accettato: listing completo per T1/legacyLeft/finalize, ids solo per gli assenti |
| R-MAJOR busy perde decryptLegacy | Accettato: lock del giro in attesa, signal, `'busy'` |
| R-MINOR precedenza / Qf altro | Accettato: ordine esplicito, Qf altro = NONE |
| R-MINOR T9 contro I5 | Accettato: NONE se la CREATE è già canonica |
| R-MINOR I2 violato dalla pull | Accettato: I2 ristretto e flip con lock |
| R-MINOR sentHash fuori scope | Accettato. -1 con `slice(0)` lascia già la lista intatta |
| R-MINOR E2E senza content | Accettato: E2E online. Respinto `GET /notes/:id` nella pull (plaintext in memoria, N richieste) |
| R-MINOR test 765 | Accettato: da sostituire |
| RT-MAJOR pull sotto lock | Accettato con flip lock-aware. Respinto il liveQuery in T18 (scope; il caso finisce comunque in T11) |
| RT-MAJOR leak fra utenti | Accettato: filtro Z e I7. `noteItems` filtra già gli item per userId (`vaultReconcile.ts:61`); le righe no |
| RT-MAJOR T5 CREATE / T6 REENCRYPT | Accettato: override dei campi e UPDATE{content} accodato |
| RT-MINOR T3 con Hs==base | Accettato: REQUEUE. Senza locks la perdita locale è già avvenuta prima, non la crea il reconcile |
| RT-MINOR trigger busy perso | Accettato: stesso fix del lock in attesa |
| RT-NIT status nello snapshot | Accettato |

## (c) Riassunto per l'utente

Tutti i 15 rilievi (9 del reviewer, 6 del red-team) sono accolti, due in forma ridotta. Rispetto al codice attuale cambia questo:
- **Il modello.** Il riconciliatore del vault diventa una tabella di decisioni pura (`decide`), e ogni decisione si applica in una sola transazione per nota. Spariscono l'id deterministico delle copie, il seme e l'heartbeat in localStorage.
- **I primitivi.**
  - Web Lock per nota, tenuto dall'editor aperto.
  - Un lock per il giro che ora aspetta invece di rinunciare. Così il wizard delle credenziali legacy e i trigger dell'editor non si perdono.
  - Id casuale per le copie.
  - Una lista di hash inviati, che si accorcia solo per prefisso.
- **I casi nuovi.**
  - Note non vault con un errore vault in coda: diventano item normali, oppure una copia, secondo il caso.
  - Il riconciliatore tocca solo righe dell'utente collegato: niente fughe fra account sullo stesso browser.
  - Una credenziale riattivata conserva il suo tipo.
  - Due schede che scrivono la stessa nota non generano più copie spurie.
- **TIER 1.** In `syncService.ts` servono 3 modifiche, da approvare: hash inviati atomici, rimozione a prefisso anche per la CREATE, e il cambio vault/non vault della pull che rispetta il lock dell'editor.
- **Backend.**
  - `POST /vault/items` restituisce anche gli id assenti e quelli non vault.
  - `note.service.ts` risponde 422 se arriva una nota cifrata su una nota non vault. Oggi la sovrascrive in silenzio.
  - Nessuna migration, nessuna versione Dexie nuova.
- **Limiti che restano.** Una nota spostata fuori dal vault è vuota offline finché non la apri online. Una scheda iOS sospesa può far aspettare il riconciliatore.

Non ho verificato: il comportamento di `POST /vault/items` con vault bloccato, se una PUT con 404 scarta l'UPDATE, e il codice di T18 (non esiste ancora). I diff di `syncService.ts` sono TIER 1 e non si applicano senza la tua conferma esplicita.
## Addendum 1 (22/10): modi dei lock e stato al listing

Questo addendum prevale sulla sezione "Lock": durante la verifica dell'implementazione è emerso un difetto.
- **Modi del lock della nota.** `withNoteLock(id, fn, { ifAvailable, mode })`, con `mode` che vale `exclusive` (default) o `shared`.
  - **Editor (T18):** tiene il lock `shared` per tutto il tempo in cui la nota è aperta.
  - **Push di un item NOTE vault con piano `send`:** `shared` con `ifAvailable`, quindi convive con l'editor. Se un holder `exclusive` lo tiene, l'item salta il giro senza cambiare stato. Senza `navigator.locks` il percorso è quello di prima.
  - **Commit per nota del reconcile e flip della pull:** `exclusive` con `ifAvailable`. Sono esclusi sia dall'editor aperto sia da una push in corso.
  - **Motivo:** con un lock esclusivo tenuto dall'editor, la push di una nota aperta sarebbe stata saltata per tutto il tempo in cui la nota restava aperta.
- **Stato al listing.** Al listing il giro registra, per ogni candidato, `vaultBaseHash`, `syncStatus` e `updatedAt` della riga, più id, `status` e `lastError` degli item. Al commit, se qualcosa è cambiato, la nota va in LATER. Chiude il caso di una push arrivata fra il listing e il commit, che avrebbe portato a una HYDRATE dell'envelope vecchio.
- **Single-flight.** Con un giro in volo, ogni chiamata accoda al massimo un giro successivo. Più chiamate collassano in uno solo, che usa `decryptLegacy` se almeno una delle chiamate lo porta.
