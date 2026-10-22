import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { db } from '../../lib/db';
import { removeFromDevice, setOfflineUnlock } from '../../lib/vaultSession';
import { useAuthStore } from '../../store/authStore';
import { useVaultStore } from '../../store/vaultStore';

const LINK = 'inline-flex items-center min-h-[44px] text-sm text-emerald-600 hover:underline dark:text-emerald-400';

/**
 * Righe Dexie vault (note e tag) dell'utente. Con item di coda o righe non `synced` (anche senza item: riga sporca, coda pulita)
 * ritorna quante sono e non tocca nulla; altrimenti, con `remove`, cancella le righe. Tutto in una transazione:
 * nessun item puo' comparire fra controllo e cancellazione.
 */
async function vaultRows(userId: string, remove: boolean): Promise<number> {
  return db.transaction('rw', db.notes, db.tags, db.syncQueue, async () => {
    const mine = (r: { isVault?: boolean; userId: string }) => !!r.isVault && r.userId === userId;
    const notes = await db.notes.filter(mine).primaryKeys();
    const tags = await db.tags.filter(mine).primaryKeys();
    const dirtyNotes = await db.notes.filter((n) => mine(n) && n.syncStatus !== 'synced').primaryKeys();
    const dirtyTags = await db.tags.filter((g) => mine(g) && g.syncStatus !== 'synced').primaryKeys();
    const ids = new Set<string>([...notes, ...tags]);
    const queued = await db.syncQueue.where('userId').equals(userId).filter((i) => ids.has(i.entityId)).toArray();
    const pending = new Set<string>([...dirtyNotes, ...dirtyTags, ...queued.map((i) => i.entityId)]);
    if (pending.size > 0) return pending.size;
    if (remove) {
      await db.notes.bulkDelete(notes);
      await db.tags.bulkDelete(tags);
    }
    return 0;
  });
}

/**
 * Impostazioni vault in Settings (piano 5.4): non richiede il vault sbloccato (switch offline, rimozione, spiegazione, link).
 * Il controllo del reconcile e i suoi esiti stanno nel VaultSettingsSheet, visibile solo da sbloccato.
 */
export default function VaultSettingsSection() {
  const { t } = useTranslation();
  const userId = useAuthStore((s) => s.user?.id);
  const cache = useVaultStore((s) => (userId ? s.byUser[userId] : undefined));
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [blocked, setBlocked] = useState(0);

  if (!userId) return null;
  const offline = !!cache?.offlineUnlock;

  const toggleOffline = async () => {
    try { await setOfflineUnlock(userId, !offline); } catch { toast.error(t('errors.common.unknownError')); }
  };

  const askRemove = async () => {
    setBlocked(0);
    try {
      const n = await vaultRows(userId, false);
      if (n > 0) setBlocked(n);
      else setConfirmOpen(true);
    } catch {
      toast.error(t('errors.common.unknownError'));
    }
  };

  const doRemove = async () => {
    try {
      const n = await vaultRows(userId, true);
      if (n > 0) return setBlocked(n); // un elemento e' comparso dopo il controllo
      await removeFromDevice(userId);
      toast.success(t('vault.settings.removed'));
    } catch {
      toast.error(t('errors.common.unknownError'));
    }
  };

  return (
    <section>
      <h2 className="text-lg font-semibold text-neutral-900 dark:text-white mb-4">{t('vault.settings.section')}</h2>
      <Card className="p-6 dark:bg-neutral-800 dark:border-neutral-700 space-y-5">
        {cache && (
          <>
            {cache.status === 'READY' && <div className="flex items-center justify-between gap-4">
              <div>
                <h3 className="font-medium text-neutral-900 dark:text-white">{t('vault.settings.offlineUnlock')}</h3>
                <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('vault.settings.offlineUnlockDesc')}</p>
                {offline && <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">{t('vault.settings.offlineUnlockNext')}</p>}
              </div>
              <button
                type="button"
                onClick={toggleOffline}
                role="switch"
                aria-checked={offline}
                aria-label={t('vault.settings.offlineUnlock')}
                className="min-h-[44px] min-w-[44px] flex-shrink-0 inline-flex items-center justify-center rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
              >
                <span className={clsx('relative inline-flex h-7 w-12 items-center rounded-full transition-colors duration-200', offline ? 'bg-emerald-500' : 'bg-neutral-300 dark:bg-neutral-600')}>
                  <span className={clsx('inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200', offline ? 'translate-x-6' : 'translate-x-1')} />
                </span>
              </button>
            </div>}

            <div className="border-t border-neutral-200 dark:border-neutral-700" />
            <div>
              <h3 className="font-medium text-neutral-900 dark:text-white">{t('vault.settings.removeTitle')}</h3>
              <p className="text-sm text-neutral-500 dark:text-neutral-400 mb-3">{t('vault.settings.removeDesc')}</p>
              {blocked > 0 && (
                <p role="alert" className="mb-3 text-sm text-red-600 dark:text-red-400">{t('vault.settings.removeBlocked', { n: blocked })}</p>
              )}
              <Button type="button" variant="danger" className="min-h-[44px]" onClick={askRemove}>
                {t('vault.settings.removeButton')}
              </Button>
            </div>
            <div className="border-t border-neutral-200 dark:border-neutral-700" />
          </>
        )}

        <details>
          <summary className="cursor-pointer min-h-[44px] flex items-center font-medium text-neutral-900 dark:text-white">{t('vault.settings.howTitle')}</summary>
          <ul className="mt-2 list-disc pl-6 space-y-2 text-sm text-neutral-600 dark:text-neutral-400">
            {(['pin', 'kit', 'offline', 'device'] as const).map((k) => (
              <li key={k}>{t(`vault.settings.how.${k}`)}</li>
            ))}
          </ul>
        </details>

        <Link to="/vault" className={LINK}>{t('vault.settings.openVault')}</Link>
      </Card>

      <ConfirmDialog
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={doRemove}
        title={t('vault.settings.removeConfirmTitle')}
        message={t('vault.settings.removeConfirmBody')}
        confirmText={t('vault.settings.removeButton')}
        cancelText={t('common.cancel')}
        variant="danger"
      />
    </section>
  );
}
