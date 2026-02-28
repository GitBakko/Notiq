import { useTranslation } from 'react-i18next';
import { X, Users, Crown, Clock } from 'lucide-react';

export interface SharedUserInfo {
  id: string;
  name: string | null;
  email: string;
  avatarUrl?: string | null;
  permission?: string;
  status?: 'ACCEPTED' | 'PENDING';
}

export interface SharedOwnerInfo {
  id: string;
  name: string | null;
  email: string;
  avatarUrl?: string | null;
}

interface SharedUsersModalProps {
  isOpen: boolean;
  onClose: () => void;
  users: SharedUserInfo[];
  title?: string;
  currentUserId?: string;
  owner?: SharedOwnerInfo | null;
}

export default function SharedUsersModal({ isOpen, onClose, users, title, currentUserId, owner }: SharedUsersModalProps) {
  const { t } = useTranslation();

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl dark:bg-neutral-900 dark:border dark:border-neutral-800/40"
        onClick={e => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Users size={18} className="text-emerald-600 dark:text-emerald-400" />
            <h2 className="text-lg font-bold text-neutral-900 dark:text-white">
              {title || t('sharing.sharedWith')}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200 rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
            aria-label={t('common.close')}
          >
            <X size={18} />
          </button>
        </div>

        {/* Owner section */}
        {owner && (
          <div className="mb-3">
            <div className="flex items-center gap-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/30 p-3">
              {owner.avatarUrl ? (
                <img
                  src={owner.avatarUrl.replace(/^https?:\/\/localhost:\d+/, '')}
                  alt=""
                  className="h-9 w-9 rounded-full object-cover flex-shrink-0"
                  loading="lazy"
                  decoding="async"
                />
              ) : (
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-amber-100 text-sm font-bold text-amber-700 dark:bg-amber-900/40 dark:text-amber-400 flex-shrink-0">
                  {owner.name?.[0]?.toUpperCase() || owner.email?.[0]?.toUpperCase() || '?'}
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-medium text-neutral-900 dark:text-white truncate">
                    {owner.name || owner.email || '—'}
                  </span>
                  {currentUserId && owner.id === currentUserId && (
                    <span className="flex-shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400">
                      {t('sharing.you')}
                    </span>
                  )}
                </div>
                {owner.name && (
                  <div className="text-xs text-neutral-500 dark:text-neutral-400 truncate">
                    {owner.email}
                  </div>
                )}
              </div>
              <span className="flex-shrink-0 flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-amber-200 dark:bg-amber-800/50 text-amber-800 dark:text-amber-300">
                <Crown size={10} />
                {t('sharing.owner')}
              </span>
            </div>
          </div>
        )}

        {(() => {
          const acceptedUsers = users.filter(u => u.status !== 'PENDING');
          const pendingUsers = users.filter(u => u.status === 'PENDING');
          const hasNoUsers = acceptedUsers.length === 0 && pendingUsers.length === 0;

          return (
            <>
              {hasNoUsers && !owner ? (
                <p className="text-sm text-neutral-500 dark:text-neutral-400 italic py-4 text-center">
                  {t('sharing.noOne')}
                </p>
              ) : hasNoUsers ? (
                <p className="text-xs text-neutral-400 dark:text-neutral-500 italic text-center py-2">
                  {t('sharing.noOtherUsers')}
                </p>
              ) : (
                <div className="space-y-4 max-h-[60vh] overflow-y-auto">
                  {/* Accepted users */}
                  {acceptedUsers.length > 0 && (
                    <ul className="space-y-2">
                      {acceptedUsers.map(user => (
                        <li key={user.id} className="flex items-center gap-3 rounded-lg bg-neutral-50 dark:bg-neutral-800 p-3">
                          {user.avatarUrl ? (
                            <img
                              src={user.avatarUrl.replace(/^https?:\/\/localhost:\d+/, '')}
                              alt=""
                              className="h-9 w-9 rounded-full object-cover flex-shrink-0"
                              loading="lazy"
                              decoding="async"
                            />
                          ) : (
                            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-100 text-sm font-bold text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 flex-shrink-0">
                              {user.name?.[0]?.toUpperCase() || user.email?.[0]?.toUpperCase() || '?'}
                            </div>
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="text-sm font-medium text-neutral-900 dark:text-white truncate">
                                {user.name || user.email || '—'}
                              </span>
                              {currentUserId && user.id === currentUserId && (
                                <span className="flex-shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400">
                                  {t('sharing.you')}
                                </span>
                              )}
                            </div>
                            {user.name && (
                              <div className="text-xs text-neutral-500 dark:text-neutral-400 truncate">
                                {user.email}
                              </div>
                            )}
                          </div>
                          {user.permission && (
                            <span className="flex-shrink-0 text-[10px] font-medium px-2 py-0.5 rounded-full bg-neutral-200 dark:bg-neutral-700 text-neutral-600 dark:text-neutral-300">
                              {user.permission === 'WRITE' ? t('sharing.readWrite') : t('sharing.readOnly')}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}

                  {/* Pending users */}
                  {pendingUsers.length > 0 && (
                    <div>
                      <h3 className="text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-2 flex items-center gap-1.5">
                        <Clock size={12} />
                        {t('sharing.pendingSection')}
                      </h3>
                      <ul className="space-y-2">
                        {pendingUsers.map(user => (
                          <li key={user.id} className="flex items-center gap-3 rounded-lg bg-neutral-50 dark:bg-neutral-800/50 p-3">
                            {user.avatarUrl ? (
                              <img
                                src={user.avatarUrl.replace(/^https?:\/\/localhost:\d+/, '')}
                                alt=""
                                className="h-9 w-9 rounded-full object-cover flex-shrink-0 opacity-60"
                                loading="lazy"
                                decoding="async"
                              />
                            ) : (
                              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-neutral-200 text-sm font-bold text-neutral-400 dark:bg-neutral-700 dark:text-neutral-500 flex-shrink-0">
                                {user.name?.[0]?.toUpperCase() || user.email?.[0]?.toUpperCase() || '?'}
                              </div>
                            )}
                            <div className="flex-1 min-w-0">
                              <span className="text-sm font-medium text-neutral-400 dark:text-neutral-500 truncate block">
                                {user.name || user.email || '—'}
                              </span>
                              {user.name && (
                                <div className="text-xs text-neutral-400 dark:text-neutral-500 truncate">
                                  {user.email}
                                </div>
                              )}
                            </div>
                            <span className="flex-shrink-0 flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">
                              <Clock size={10} />
                              {t('sharing.pendingLabel')}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </>
          );
        })()}
      </div>
    </div>
  );
}
