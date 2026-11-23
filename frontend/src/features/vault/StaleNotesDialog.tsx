import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../../components/ui/Dialog';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Button } from '../../components/ui/Button';
import type { UnreadableItem } from './vaultMigration';

/** `tooLarge`: l'envelope vecchio supera `MAX_REWRAP_LEN`, quindi non si re-incapsula (D7). */
export type StaleItem = UnreadableItem & { tooLarge: boolean };

interface Props {
  /** Note che dopo il cambio di chiave nessuna chiave apre (mai vuoto: la pagina non monta il dialog). */
  items: StaleItem[];
  /** Esito del tentativo precedente, se ha lasciato un residuo: il dialog si riapre con questa riga. */
  last?: { rewrapped: number };
  /** Un rewrap o un'eliminazione e' in corso: nessun pulsante. */
  busy: boolean;
  /** Conferma: re-incapsula le note entro il limite come note illeggibili (l'envelope vecchio resta dentro la nota). */
  onConfirm: () => void;
  /** Dopo la conferma del ConfirmDialog: elimina definitivamente le note D (AEAD fallito con una chiave valida) oltre il limite. K e U oltre il limite non si eliminano mai (D16, D18). */
  onDeleteDamaged: () => void;
  /** Annulla (o Esc, o click fuori): nessuna scrittura, il vault resta usabile e il banner della pagina riapre il dialog. */
  onCancel: () => void;
}

/** Un solo dialog per le note illeggibili dopo una rotazione. Gruppi per motivo (D/K) e poi per limite di dimensione. */
export default function StaleNotesDialog({ items, last, busy, onConfirm, onDeleteDamaged, onCancel }: Props) {
  const { t } = useTranslation();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const count = (reason: StaleItem['reason'], tooLarge: boolean) => items.filter((i) => i.reason === reason && i.tooLarge === tooLarge).length;
  const rewrapD = count('damaged', false);
  const rewrapK = count('keyMissing', false);
  const rewrapU = count('unverifiable', false);
  const delD = count('damaged', true);
  const stuckK = count('keyMissing', true);
  const stuckU = count('unverifiable', true);

  // Un solo overlay alla volta (focus trap): il ConfirmDialog sostituisce il dialog, e annullare lo riporta
  if (confirmDelete) {
    return (
      <ConfirmDialog
        isOpen
        onClose={() => setConfirmDelete(false)}
        onConfirm={onDeleteDamaged}
        title={t('vault.rotation.deleteTooLargeTitle')}
        message={t('vault.rotation.deleteTooLargeConfirm', { count: delD })}
        confirmText={t('common.deleteForever')}
        cancelText={t('common.cancel')}
        variant="danger"
      />
    );
  }

  return (
    <Dialog isOpen onClose={onCancel} title={t('vault.rotation.dialogTitle')} className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
      <div className="space-y-3 text-sm text-neutral-600 dark:text-neutral-300">
        {last && (
          <p role="status">
            {last.rewrapped > 0 && <span>{t('vault.rotation.rewrapDone', { count: last.rewrapped })} </span>}
            <span>{t('vault.rotation.residue')}</span>
          </p>
        )}
        {rewrapD > 0 && <p>{t('vault.rotation.damaged', { count: rewrapD })}</p>}
        {rewrapK > 0 && (
          <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
            {t('vault.rotation.keyMissingWarning', { count: rewrapK })}
          </p>
        )}
        {rewrapU > 0 && (
          <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
            {t('vault.rotation.unverifiableWarning', { count: rewrapU })}
          </p>
        )}
        {delD > 0 && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-800 dark:border-red-700 dark:bg-red-900/20 dark:text-red-300">
            {t('vault.rotation.tooLarge', { count: delD })}
          </p>
        )}
        {stuckK > 0 && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-800 dark:border-red-700 dark:bg-red-900/20 dark:text-red-300">
            {t('vault.rotation.keyMissingTooLarge', { count: stuckK })}
          </p>
        )}
        {stuckU > 0 && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-800 dark:border-red-700 dark:bg-red-900/20 dark:text-red-300">
            {t('vault.rotation.unverifiableTooLarge', { count: stuckU })}
          </p>
        )}
      </div>
      <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Button variant="ghost" className="min-h-[44px]" disabled={busy} onClick={onCancel}>{t(rewrapD + rewrapK + rewrapU > 0 ? 'common.cancel' : 'common.close')}</Button>
        {delD > 0 && (
          <Button variant="danger" className="min-h-[44px]" disabled={busy} onClick={() => setConfirmDelete(true)}>{t('vault.rotation.deleteTooLarge', { count: delD })}</Button>
        )}
        {rewrapD + rewrapK + rewrapU > 0 && <Button variant="primary" className="min-h-[44px]" disabled={busy} onClick={onConfirm}>{t('vault.rotation.confirmRewrap')}</Button>}
      </div>
    </Dialog>
  );
}
