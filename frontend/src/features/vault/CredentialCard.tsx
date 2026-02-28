import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound, Globe } from 'lucide-react';
import clsx from 'clsx';
import type { LocalNote } from '../../lib/db';
import { decryptCredential, extractDomain, isValidAbsoluteUrl } from './credentialTypes';
import { useVaultStore } from '../../store/vaultStore';

interface CredentialCardProps {
  note: LocalNote;
  isSelected: boolean;
  onClick: () => void;
}

export default function CredentialCard({ note, isSelected, onClick }: CredentialCardProps) {
  const { t } = useTranslation();
  const { pin } = useVaultStore();
  const [imgError, setImgError] = useState(false);

  // Try to extract domain and favicon
  let domain = '';
  let faviconUrl: string | null = null;
  if (pin && note.content) {
    const data = decryptCredential(note.content, pin);
    if (data?.siteUrl) {
      domain = extractDomain(data.siteUrl);
      // Use stored favicon (if valid absolute URL) or fall back to DuckDuckGo's service
      if (isValidAbsoluteUrl(data.faviconUrl)) {
        faviconUrl = data.faviconUrl!;
      } else {
        try {
          const hostname = new URL(data.siteUrl).hostname;
          faviconUrl = `https://icons.duckduckgo.com/ip3/${hostname}.ico`;
        } catch {
          faviconUrl = null;
        }
      }
    }
  }

  return (
    <button
      onClick={onClick}
      className={clsx(
        'w-full text-left p-3 rounded-lg transition-colors border',
        isSelected
          ? 'bg-emerald-50 border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-800'
          : 'bg-white dark:bg-neutral-800 border-transparent hover:bg-neutral-50 dark:hover:bg-neutral-700/50'
      )}
    >
      <div className="flex items-start gap-2.5">
        {/* Favicon or fallback icon */}
        {faviconUrl && !imgError ? (
          <img
            src={faviconUrl}
            alt=""
            className="w-5 h-5 mt-0.5 rounded flex-shrink-0 bg-neutral-100 dark:bg-neutral-700"
            onError={() => setImgError(true)}
          />
        ) : domain ? (
          <Globe
            size={16}
            className={clsx(
              'mt-0.5 flex-shrink-0',
              isSelected ? 'text-emerald-600 dark:text-emerald-400' : 'text-neutral-400 dark:text-neutral-500'
            )}
          />
        ) : (
          <KeyRound
            size={16}
            className={clsx(
              'mt-0.5 flex-shrink-0',
              isSelected ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-500 dark:text-amber-400'
            )}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3
              className={clsx(
                'font-medium truncate text-sm',
                isSelected ? 'text-emerald-700 dark:text-emerald-400' : 'text-neutral-900 dark:text-white'
              )}
            >
              {note.title || t('vault.credential.untitled')}
            </h3>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 flex-shrink-0">
              {t('vault.credential.badge')}
            </span>
          </div>
          {domain && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400 truncate mt-0.5">{domain}</p>
          )}
          {note.tags && note.tags.length > 0 && (
            <div className="flex gap-1 mt-1 flex-wrap">
              {note.tags.map((tagEntry: { tag?: { id: string; name: string }; tagId?: string }) => (
                <span key={tagEntry.tag?.id || tagEntry.tagId} className="text-[10px] px-1.5 py-0.5 rounded-full bg-neutral-100 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-400">
                  {tagEntry.tag?.name || ''}
                </span>
              ))}
            </div>
          )}
          <p className="text-xs text-neutral-400 dark:text-neutral-500 mt-1">
            {new Date(note.updatedAt).toLocaleDateString()}
          </p>
        </div>
      </div>
    </button>
  );
}
