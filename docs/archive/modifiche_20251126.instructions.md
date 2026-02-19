# Modifiche 27/11/2025

## Generale

- Devi trovare tutti i placeholders delle traduzioni per le label ancora mancanti ed inserirle. Non voglio più vedere neanche un placeholder del tipo "gender.male" o altro.
- La modal della ricerca non acquisisce correttamente il tema Dark. Rimane in un limbo tra Dark e Light theme che non ne consente l'utilizzo corretto: i testi non sono leggibili, il cursore non si vede... Risolvi
- Verifica che esista nel backend un file di configurazione in cui sono registrati anche i dati dell'SMTP da utilizzare per tutti gli invii delle email da Notiq
- Modifica il file .gitignore per NON sincronizzare allegati e foto profili
 
## Tags

- il tasto "+" per aggiungere il tag direttamente dalla sidebar non funziona
- se provo ad aggiungere un tag dall'editor delle note, il popup della ricerca/inserimento del tag rimane dentro al div in cui sta il tasto dell'aggiunta. In questo modo appare la scrollbar piccolissima a destra dell'elemento ed il tutto diventa inutilizzabile

## Editor delle note

- Devi aggiungere al wysiwyg la selezione dei font e della dimensione del testo
- Il caricamento degli allegati non funziona. questa la console con gli errori:

```
useSync.ts:12 Starting sync...
syncService.ts:81 Sync Pull Completed
useSync.ts:15 Sync completed
attachmentService.ts:16  POST http://127.0.0.1:3001/api/attachments?noteId=1bb34b84-ca66-4b50-9103-d3500753ef3d 404 (Not Found)
dispatchXhrRequest @ axios.js?v=c7360d05:1696
xhr @ axios.js?v=c7360d05:1573
dispatchRequest @ axios.js?v=c7360d05:2107
Promise.then
_request @ axios.js?v=c7360d05:2310
request @ axios.js?v=c7360d05:2219
httpMethod @ axios.js?v=c7360d05:2356
wrap @ axios.js?v=c7360d05:8
uploadAttachment @ attachmentService.ts:16
handleFileChange @ NoteEditor.tsx:195
executeDispatch @ react-dom_client.js?v=c7360d05:13622
runWithFiberInDEV @ react-dom_client.js?v=c7360d05:997
processDispatchQueue @ react-dom_client.js?v=c7360d05:13658
(anonime) @ react-dom_client.js?v=c7360d05:14071
batchedUpdates$1 @ react-dom_client.js?v=c7360d05:2626
dispatchEventForPluginEventSystem @ react-dom_client.js?v=c7360d05:13763
dispatchEvent @ react-dom_client.js?v=c7360d05:16784
dispatchDiscreteEvent @ react-dom_client.js?v=c7360d05:16765
installHook.js:1 Upload failed AxiosError {message: 'Request failed with status code 404', name: 'AxiosError', code: 'ERR_BAD_REQUEST', config: {…}, request: XMLHttpRequest, …}
overrideMethod @ installHook.js:1
uploadAttachment @ attachmentService.ts:35
await in uploadAttachment
handleFileChange @ NoteEditor.tsx:195
executeDispatch @ react-dom_client.js?v=c7360d05:13622
runWithFiberInDEV @ react-dom_client.js?v=c7360d05:997
processDispatchQueue @ react-dom_client.js?v=c7360d05:13658
(anonime) @ react-dom_client.js?v=c7360d05:14071
batchedUpdates$1 @ react-dom_client.js?v=c7360d05:2626
dispatchEventForPluginEventSystem @ react-dom_client.js?v=c7360d05:13763
dispatchEvent @ react-dom_client.js?v=c7360d05:16784
dispatchDiscreteEvent @ react-dom_client.js?v=c7360d05:16765
installHook.js:1 Failed to upload lock2022-b38_durdledoorengland_alamy-bwxgge_rm_1920x1080_1663800182783.jpg AxiosError {message: 'Request failed with status code 404', name: 'AxiosError', code: 'ERR_BAD_REQUEST', config: {…}, request: XMLHttpRequest, …}
overrideMethod @ installHook.js:1
handleFileChange @ NoteEditor.tsx:198
await in handleFileChange
executeDispatch @ react-dom_client.js?v=c7360d05:13622
runWithFiberInDEV @ react-dom_client.js?v=c7360d05:997
processDispatchQueue @ react-dom_client.js?v=c7360d05:13658
(anonime) @ react-dom_client.js?v=c7360d05:14071
batchedUpdates$1 @ react-dom_client.js?v=c7360d05:2626
dispatchEventForPluginEventSystem @ react-dom_client.js?v=c7360d05:13763
dispatchEvent @ react-dom_client.js?v=c7360d05:16784
dispatchDiscreteEvent @ react-dom_client.js?v=c7360d05:16765
```

- L'icona degli allegati deve avere, se presenti, un badge carino ed elegante che indichi quanti allegati sono presenti

## Vault sicuro

- Esiste un flusso di recupero del PIN impostato per il vault? Se NO pianificane la creazione