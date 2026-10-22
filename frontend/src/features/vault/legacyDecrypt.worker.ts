import { decryptContent } from '../../utils/crypto';

// PBKDF2 (100k iterazioni) del vault legacy fuori dal thread UI: ~2 s per tentativo su mobile (v2: sale per item, nessuna chiave condivisa).
// Il PIN e il testo in chiaro vivono solo qui e nel messaggio di ritorno; nessun log.
self.onmessage = (e: MessageEvent<{ id: number; content: string; pin: string }>) => {
  const { id, content, pin } = e.data;
  (self as unknown as Worker).postMessage({ id, plain: decryptContent(content, pin) });
};
