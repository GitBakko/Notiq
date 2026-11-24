// Azioni sulle note rimaste illeggibili dopo un cambio di chiave (P4 fase 5): condivise da VaultPage (sessione sbloccata, `live` di default) e dal recupero
// (chiavi catturate da openRecoveryContext, `live: false`). Nessuno stato React qui: i chiamanti gestiscono dialog, toast e single-flight.
import type { VaultCodecCtx } from '../../lib/vaultCodec';
import { db } from '../../lib/db';
import { withNoteLock } from '../../lib/vaultNoteLock';
import { syncPush } from '../sync/syncService';
import { permanentlyDeleteNote } from '../notes/noteService';
import type { StaleItem } from './StaleNotesDialog';
import { finishRotation, MAX_REWRAP_LEN, rewrapUnreadable, type RewrapResult, type RotationResult, type UnreadableItem } from './vaultMigration';

/** `tooLarge`: envelope oltre MAX_REWRAP_LEN o rifiutato dal rewrap (D7). */
export const markStale = (u: UnreadableItem, rewrapRefused: string[] = []): StaleItem => ({ ...u, tooLarge: u.size > MAX_REWRAP_LEN || rewrapRefused.includes(u.id) });

interface LiveOpt { live?: boolean }
/** `live: false` solo se esplicito: col default le chiamate restano identiche a prima (nessuna opzione in piu'). */
const liveOpt = (o: LiveOpt): { live?: false } => (o.live === false ? { live: false } : {});

/** Le note che il rewrap tocca dopo conferma: tutte tranne le oltre-limite (le D si eliminano, le K e U non si toccano mai: D7, D16). */
export const rewrapTargets = (items: StaleItem[]): StaleItem[] => items.filter((i) => !i.tooLarge);

/** Le sole D (AEAD fallito con chiave valida) oltre il limite: le uniche eliminabili (D18). */
export const deletableIds = (items: StaleItem[]): string[] => items.filter((i) => i.tooLarge && i.reason === 'damaged').map((i) => i.id);

/**
 * Conferma del dialog: re-incapsula le note entro il limite (consenso per nota: solo le K e U, non verificabili, si re-incapsulano senza una chiave che le apra),
 * poi `finishRotation` (il residuo e' la verita' del server: comprende conflitti, failed e unverified, che restano stale). `null` se non c'e' nulla da re-incapsulare.
 */
export async function rewrapThenFinish(ctx: VaultCodecCtx, items: StaleItem[], o: LiveOpt = {}): Promise<{ rw: RewrapResult; fin: RotationResult } | null> {
  const todo = rewrapTargets(items);
  if (todo.length === 0) return null;
  const rw = await rewrapUnreadable(todo.map((i) => i.id), ctx, { allowKeyMissingIds: todo.filter((i) => i.reason !== 'damaged').map((i) => i.id), ...liveOpt(o) });
  const fin = await finishRotation({ ctx, ...liveOpt(o) });
  return { rw, fin };
}

/**
 * D7/D18: le D oltre ~1,5 MiB non si re-incapsulano; si eliminano (cancellazione definitiva locale + DELETE in coda). Il cestino non basta: staleCount del server conta
 * anche le note nel cestino. L'eliminazione e' irreversibile: si riclassifica ORA (non lo snapshot) e si elimina solo cio' che il server riconferma troppo grande e senza chiave
 * che lo apra (`rw.tooLarge`). Poi la push porta il DELETE al server prima di rileggerne lo stato con `finishRotation`.
 * Mai DROP di edit offline: una nota con riga Dexie non sincronizzata o con un item in coda NON si elimina (un server ostile potrebbe farla apparire come D): resta nel residuo, `onSkipped` ne da il conteggio.
 * Nota occupata altrove (lock) o senza navigator.locks: stesso esito ma motivo diverso, `onBusy`.
 * Una nota gia' eliminata col DELETE `failed` in coda (syncPush salta i `failed`: terminali) riattiva quel DELETE prima della push. Una nota che dopo la push risulta ancora illeggibile
 * per il server NON e' eliminata: finisce in `unconfirmed` (non in `gone`) e `onPendingSync` avvisa; `onDeleted` conta solo le confermate, dopo la rilettura.
 * `null` se non c'e' nessuna D oltre il limite.
 */
export async function deleteDamagedThenFinish(ctx: VaultCodecCtx, items: StaleItem[], o: LiveOpt & { onDeleted?: (count: number) => void; onSkipped?: (count: number) => void; onBusy?: (count: number) => void; onPendingSync?: (count: number) => void } = {}): Promise<{ gone: Set<string>; unconfirmed: Set<string>; fin: RotationResult; skipped: number; busy: number } | null> {
  const ids = deletableIds(items);
  if (ids.length === 0) return null;
  const deleted = new Set<string>();
  const pending = new Set<string>();
  const busy = new Set<string>();
  const rw = await (o.live === false ? rewrapUnreadable(ids, ctx, { live: false }) : rewrapUnreadable(ids, ctx));
  for (const id of rw.tooLarge) {
    // Lock esclusivo della nota (gli editor scrivono tenendo `shared`); dentro, ricontrollo ed eliminazione in UNA transazione Dexie (permanentlyDeleteNote tocca solo notes e syncQueue).
    // Lock occupato o assente (senza navigator.locks): nel dubbio non si elimina.
    const r = await withNoteLock(id, () => db.transaction('rw', db.notes, db.syncQueue, async () => {
      const st = await noteState(id);
      if (st === 'dirty') return 'pending' as const;
      if (st === 'deleted') { // eliminata da un giro precedente: il DELETE e' gia' in coda, non se ne accoda un secondo; se e' `failed` la push lo salterebbe per sempre
        const failed = await db.syncQueue.filter((i) => i.entity === 'NOTE' && i.entityId === id && i.type === 'DELETE' && i.status === 'failed').toArray();
        for (const i of failed) if (i.id !== undefined) await db.syncQueue.update(i.id, { status: 'pending', attempts: 0 }); // come retryFailedSyncItems
        return 'gone' as const;
      }
      await permanentlyDeleteNote(id);
      return 'gone' as const;
    }), { mode: 'exclusive', ifAvailable: true });
    if (r.status === 'ran') (r.value === 'gone' ? deleted : pending).add(id); else busy.add(id);
  }
  if (pending.size > 0) o.onSkipped?.(pending.size);
  if (busy.size > 0) o.onBusy?.(busy.size);
  if (deleted.size > 0) await syncPush().catch(() => false); // il DELETE deve arrivare al server prima di rileggerne lo stato
  let fin: RotationResult;
  try {
    fin = await finishRotation({ ctx, ...liveOpt(o) });
  } catch (e) {
    if (deleted.size > 0) o.onPendingSync?.(deleted.size); // l'eliminazione locale e' avvenuta; la conferma del server non e' leggibile: non e' "eliminata", e' in attesa di sync
    throw e;
  }
  const stillUnreadable = new Set(fin.unreadable.map((u) => u.id));
  const unconfirmed = new Set([...deleted].filter((id) => stillUnreadable.has(id)));
  const gone = new Set([...deleted].filter((id) => !unconfirmed.has(id)));
  if (gone.size > 0) o.onDeleted?.(gone.size);
  if (unconfirmed.size > 0) o.onPendingSync?.(unconfirmed.size);
  return { gone, unconfirmed, fin, skipped: pending.size, busy: busy.size };
}

/**
 * Stato locale di una nota: `dirty` = riga Dexie non `synced` o item CREATE/UPDATE in coda (modifiche non sul server); `deleted` = riga assente con un DELETE in coda (eliminazione
 * precedente: il suo DELETE e' in coda; se e' `failed` syncPush lo salta, lo riattiva il chiamante); `clean` altrimenti. Un errore di lettura si propaga: nel dubbio non si elimina.
 */
async function noteState(id: string): Promise<'dirty' | 'deleted' | 'clean'> {
  const row = await db.notes.get(id);
  if (row && row.syncStatus !== 'synced') return 'dirty';
  const q = await db.syncQueue.filter((i) => i.entity === 'NOTE' && i.entityId === id).toArray();
  if (q.some((i) => i.type !== 'DELETE')) return 'dirty';
  return !row && q.length > 0 ? 'deleted' : 'clean';
}
