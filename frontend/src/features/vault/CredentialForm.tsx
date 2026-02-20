import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Eye, EyeOff, ExternalLink, Zap, Globe, Loader2, Camera, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import CopyButton from './CopyButton';
import PasswordGenerator from './PasswordGenerator';
import { decryptCredential, encryptCredential, EMPTY_CREDENTIAL, extractDomain, isValidAbsoluteUrl, type CredentialData } from './credentialTypes';
import { useVaultStore } from '../../store/vaultStore';
import { updateNote, deleteNote } from '../notes/noteService';
import toast from 'react-hot-toast';
import api from '../../lib/api';
import type { Note } from '../notes/noteService';

interface CredentialFormProps {
  note: Note;
  onBack: () => void;
  onDelete?: () => void;
}

function getFaviconUrl(siteUrl: string): string | null {
  try {
    const domain = new URL(siteUrl).hostname;
    return `https://icons.duckduckgo.com/ip3/${domain}.ico`;
  } catch {
    return null;
  }
}

export default function CredentialForm({ note, onBack, onDelete }: CredentialFormProps) {
  const { t } = useTranslation();
  const { pin } = useVaultStore();
  const [data, setData] = useState<CredentialData>(EMPTY_CREDENTIAL);
  const [title, setTitle] = useState(note.title);
  const [showPassword, setShowPassword] = useState(false);
  const [showGenerator, setShowGenerator] = useState(false);
  const [decryptFailed, setDecryptFailed] = useState(false);
  const [fetchingMeta, setFetchingMeta] = useState(false);
  const [fetchingScreenshot, setFetchingScreenshot] = useState(false);
  const [suggestedTitle, setSuggestedTitle] = useState<string | null>(null);
  const [faviconError, setFaviconError] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const generatorRef = useRef<HTMLDivElement>(null);
  const lastDecryptedId = useRef<string | null>(null);
  const lastFetchedUrl = useRef<string>('');
  const committedUrlRef = useRef<string>('');
  // Refs for current state — async callbacks always read the latest values
  const dataRef = useRef<CredentialData>(EMPTY_CREDENTIAL);
  const titleRef = useRef(note.title);
  // Ref for saveNow so cleanup always has the latest version
  const saveNowRef = useRef<(d: CredentialData, t: string) => void>(() => {});
  // Abort controller for in-flight metadata/screenshot fetches
  const metaAbortRef = useRef<AbortController | null>(null);
  const screenshotAbortRef = useRef<AbortController | null>(null);

  // Keep refs in sync with state
  dataRef.current = data;
  titleRef.current = title;

  // Decrypt only when note changes (not on every content update from React Query)
  useEffect(() => {
    if (lastDecryptedId.current === note.id) return;
    if (!pin || !note.content) {
      dataRef.current = EMPTY_CREDENTIAL;
      setData(EMPTY_CREDENTIAL);
      return;
    }
    const decrypted = decryptCredential(note.content, pin);
    if (decrypted) {
      dataRef.current = decrypted;
      setData(decrypted);
      setDecryptFailed(false);
      lastDecryptedId.current = note.id;
      setTitle(note.title);
      titleRef.current = note.title;
      setFaviconError(false);
      // Track the committed URL from decrypted data
      committedUrlRef.current = decrypted.siteUrl || '';
      lastFetchedUrl.current = decrypted.siteUrl || '';
    } else {
      setDecryptFailed(true);
      toast.error(t('vault.credential.decryptFailed'));
    }
  }, [note.id, note.content, pin, t]);

  // Save using refs so async code always gets the latest state
  const saveNow = useCallback(
    (newData: CredentialData, newTitle: string) => {
      if (!pin || decryptFailed) return;
      const encrypted = encryptCredential(newData, pin);
      updateNote(note.id, { title: newTitle, content: encrypted });
    },
    [note.id, pin, decryptFailed]
  );
  saveNowRef.current = saveNow;

  // Debounced save — reads from refs at fire time to always get the latest state
  const scheduleSave = useCallback(() => {
    if (!pin || decryptFailed) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveNowRef.current(dataRef.current, titleRef.current);
    }, 1000);
  }, [pin, decryptFailed]);

  const updateField = (field: keyof CredentialData, value: string) => {
    const newData = { ...dataRef.current, [field]: value };
    dataRef.current = newData;
    setData(newData);
    scheduleSave();
  };

  const handleTitleChange = (value: string) => {
    titleRef.current = value;
    setTitle(value);
    scheduleSave();
  };

  // Fetch screenshot from backend proxy — uses dataRef to avoid stale closures
  const fetchScreenshot = useCallback(
    async (url: string) => {
      // Cancel any previous screenshot fetch
      screenshotAbortRef.current?.abort();
      const controller = new AbortController();
      screenshotAbortRef.current = controller;

      setFetchingScreenshot(true);
      try {
        const { data: result } = await api.get('/url-metadata/screenshot', {
          params: { url },
          timeout: 50000,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (result.screenshotBase64) {
          // Update ref eagerly, then state — ref is single source of truth
          const updated = { ...dataRef.current, screenshotBase64: result.screenshotBase64 };
          dataRef.current = updated;
          setData(updated);
          saveNowRef.current(updated, titleRef.current);
        }
      } catch {
        // Screenshot is optional — silently fail
      } finally {
        if (!controller.signal.aborted) {
          setFetchingScreenshot(false);
        }
      }
    },
    []
  );

  // Fetch URL metadata — uses functional setData to avoid overwriting user edits
  const fetchMetadata = useCallback(
    async (url: string) => {
      if (!url || lastFetchedUrl.current === url) return;
      try {
        new URL(url); // validate URL
      } catch {
        return;
      }

      // Cancel any previous metadata fetch
      metaAbortRef.current?.abort();
      const controller = new AbortController();
      metaAbortRef.current = controller;

      lastFetchedUrl.current = url;
      setFetchingMeta(true);
      setSuggestedTitle(null);
      setFaviconError(false);

      try {
        const { data: meta } = await api.get('/url-metadata', {
          params: { url },
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;

        // Update only favicon field — ref is eagerly updated, preserving user edits
        if (meta.faviconUrl) {
          const updated = { ...dataRef.current, faviconUrl: meta.faviconUrl };
          dataRef.current = updated;
          setData(updated);
          saveNowRef.current(updated, titleRef.current);
        }

        // Suggest title if current title is empty or default
        const currentTitle = titleRef.current;
        if (meta.title && (!currentTitle || currentTitle === t('vault.credential.untitled'))) {
          setSuggestedTitle(meta.title);
        }

        // Also fetch screenshot if missing
        if (!dataRef.current.screenshotBase64) {
          fetchScreenshot(url);
        }
      } catch {
        if (controller.signal.aborted) return;
        // Still try screenshot even if metadata fails
        if (!dataRef.current.screenshotBase64) {
          fetchScreenshot(url);
        }
      } finally {
        if (!controller.signal.aborted) {
          setFetchingMeta(false);
        }
      }
    },
    [t, fetchScreenshot]
  );

  // Auto-fetch metadata + screenshot for existing credentials on mount
  const autoFetchTriggered = useRef(false);
  useEffect(() => {
    if (autoFetchTriggered.current) return;
    if (!data.siteUrl || !lastDecryptedId.current) return;
    const hasValidFavicon = isValidAbsoluteUrl(data.faviconUrl);
    const hasScreenshot = !!data.screenshotBase64;
    if (!hasScreenshot || !hasValidFavicon) {
      autoFetchTriggered.current = true;
      try {
        new URL(data.siteUrl);
        if (!hasScreenshot && !hasValidFavicon) {
          fetchMetadata(data.siteUrl);
        } else if (!hasScreenshot) {
          fetchScreenshot(data.siteUrl);
        } else {
          fetchMetadata(data.siteUrl);
        }
      } catch {
        // Invalid URL, skip
      }
    }
  }, [data.siteUrl, data.screenshotBase64, data.faviconUrl, fetchMetadata, fetchScreenshot]);

  // URL field: only save on change, fetch on blur
  const handleUrlChange = (value: string) => {
    updateField('siteUrl', value);
  };

  const handleUrlBlur = () => {
    const currentUrl = dataRef.current.siteUrl;
    if (currentUrl && currentUrl !== committedUrlRef.current) {
      committedUrlRef.current = currentUrl;
      // Flush any pending save before fetching
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveNowRef.current(dataRef.current, titleRef.current);
      }
      fetchMetadata(currentUrl);
    }
  };

  const applySuggestedTitle = () => {
    if (suggestedTitle) {
      handleTitleChange(suggestedTitle);
      setSuggestedTitle(null);
    }
  };

  const handleRetakeScreenshot = () => {
    if (data.siteUrl) {
      fetchScreenshot(data.siteUrl);
    }
  };

  const handleDelete = async () => {
    await deleteNote(note.id);
    toast.success(t('vault.credential.deleted'));
    onDelete ? onDelete() : onBack();
  };

  // Flush pending save and abort fetches on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        // Flush the pending save instead of discarding it
        saveNowRef.current(dataRef.current, titleRef.current);
      }
      metaAbortRef.current?.abort();
      screenshotAbortRef.current?.abort();
    };
  }, []);

  // Close generator on click outside
  useEffect(() => {
    if (!showGenerator) return;
    const handleClick = (e: MouseEvent) => {
      if (generatorRef.current && !generatorRef.current.contains(e.target as Node)) {
        setShowGenerator(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showGenerator]);

  // Compute favicon for display — use committed URL (not live typing) for fallback to avoid 404 spam
  const storedFavicon = isValidAbsoluteUrl(data.faviconUrl) ? data.faviconUrl : null;
  const committedUrl = committedUrlRef.current;
  const fallbackFavicon = committedUrl ? getFaviconUrl(committedUrl) : null;
  const displayFavicon = faviconError ? fallbackFavicon : (storedFavicon || fallbackFavicon);
  const domain = committedUrl ? extractDomain(committedUrl) : '';

  if (decryptFailed) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 text-gray-500 dark:text-gray-400">
        <p>{t('vault.credential.decryptFailed')}</p>
        <Button variant="ghost" onClick={onBack} className="mt-4">
          <ArrowLeft size={16} className="mr-2" />
          {t('common.back')}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-white dark:bg-gray-900 overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-800">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 text-sm"
        >
          <ArrowLeft size={16} />
          {t('common.back')}
        </button>
        <button
          onClick={() => setShowDeleteConfirm(true)}
          className="flex items-center gap-1 text-gray-400 hover:text-red-600 dark:hover:text-red-400 text-sm transition-colors"
          title={t('common.delete')}
        >
          <Trash2 size={16} />
        </button>
      </div>

      {/* Delete confirmation */}
      {showDeleteConfirm && (
        <div className="mx-6 mt-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg flex items-center justify-between gap-3">
          <p className="text-sm text-red-700 dark:text-red-400">
            {t('vault.credential.deleteConfirm')}
          </p>
          <div className="flex gap-2 flex-shrink-0">
            <Button variant="ghost" size="sm" onClick={() => setShowDeleteConfirm(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" size="sm" onClick={handleDelete}>
              {t('common.delete')}
            </Button>
          </div>
        </div>
      )}

      {/* Form wrapped to suppress Chrome password-outside-form warning */}
      <form onSubmit={(e) => e.preventDefault()} autoComplete="off" className="p-6 max-w-lg mx-auto w-full space-y-6">
        {/* Title with favicon */}
        <div className="flex items-center gap-3">
          {displayFavicon ? (
            <img
              src={displayFavicon}
              alt=""
              className="w-8 h-8 rounded-md flex-shrink-0 bg-gray-100 dark:bg-gray-800"
              onError={() => {
                if (!faviconError && storedFavicon) {
                  setFaviconError(true);
                }
              }}
            />
          ) : (
            <div className="w-8 h-8 rounded-md bg-gray-100 dark:bg-gray-800 flex items-center justify-center flex-shrink-0">
              <Globe size={16} className="text-gray-400 dark:text-gray-500" />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <input
              type="text"
              value={title}
              onChange={(e) => handleTitleChange(e.target.value)}
              placeholder={t('vault.credential.untitled')}
              className="w-full text-xl font-semibold bg-transparent border-none outline-none text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500"
            />
            {domain && (
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{domain}</p>
            )}
          </div>
        </div>

        {/* Suggested title banner */}
        {suggestedTitle && (
          <button
            type="button"
            onClick={applySuggestedTitle}
            className="w-full text-left px-3 py-2 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 rounded-lg text-sm text-emerald-700 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900/30 transition-colors"
          >
            {t('vault.credential.useSuggestedTitle', { title: suggestedTitle })}
          </button>
        )}

        {/* Website section */}
        <div className="space-y-3">
          <h4 className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">
            {t('vault.credential.websiteInfo')}
          </h4>
          <div className="bg-gray-50 dark:bg-gray-800/50 rounded-xl p-4 space-y-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400">
                {t('vault.credential.siteUrl')}
              </label>
              <div className="flex items-center gap-1">
                <div className="relative flex-1">
                  <input
                    type="url"
                    value={data.siteUrl}
                    onChange={(e) => handleUrlChange(e.target.value)}
                    onBlur={handleUrlBlur}
                    placeholder={t('vault.credential.siteUrlPlaceholder')}
                    className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                  />
                  {fetchingMeta && (
                    <Loader2 size={14} className="absolute right-2 top-1/2 -translate-y-1/2 animate-spin text-gray-400" />
                  )}
                </div>
                <CopyButton value={data.siteUrl} label={t('vault.credential.copySiteUrl')} />
                {data.siteUrl && (
                  <button
                    type="button"
                    onClick={() => window.open(data.siteUrl, '_blank', 'noopener,noreferrer')}
                    className="p-1.5 rounded-md text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-700 transition-colors"
                    title={t('vault.credential.openUrl')}
                  >
                    <ExternalLink size={16} />
                  </button>
                )}
              </div>
            </div>

            {/* Website screenshot preview */}
            {(data.screenshotBase64 || fetchingScreenshot) && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
                    {t('vault.credential.websitePreview')}
                  </span>
                  {data.screenshotBase64 && !fetchingScreenshot && (
                    <button
                      type="button"
                      onClick={handleRetakeScreenshot}
                      className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                    >
                      <RefreshCw size={12} />
                      {t('vault.credential.retakeScreenshot')}
                    </button>
                  )}
                </div>
                {fetchingScreenshot ? (
                  <div className="flex items-center justify-center h-40 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
                    <div className="flex flex-col items-center gap-2 text-gray-400">
                      <Camera size={20} className="animate-pulse" />
                      <span className="text-xs">{t('vault.credential.loadingScreenshot')}</span>
                    </div>
                  </div>
                ) : data.screenshotBase64 ? (
                  <img
                    src={data.screenshotBase64}
                    alt=""
                    className="w-full rounded-lg border border-gray-200 dark:border-gray-700 shadow-sm"
                  />
                ) : null}
              </div>
            )}
          </div>
        </div>

        {/* Login Details section */}
        <div className="space-y-3">
          <h4 className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">
            {t('vault.credential.loginDetails')}
          </h4>
          <div className="bg-gray-50 dark:bg-gray-800/50 rounded-xl p-4 space-y-4">
            {/* Username */}
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400">
                {t('vault.credential.username')}
              </label>
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  value={data.username}
                  onChange={(e) => updateField('username', e.target.value)}
                  placeholder={t('vault.credential.usernamePlaceholder')}
                  autoComplete="off"
                  className="flex-1 px-3 py-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                />
                <CopyButton value={data.username} label={t('vault.credential.copyUsername')} />
              </div>
            </div>

            {/* Password */}
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400">
                {t('vault.credential.password')}
              </label>
              <div className="flex items-center gap-1">
                <div className="relative flex-1">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={data.password}
                    onChange={(e) => updateField('password', e.target.value)}
                    placeholder={t('vault.credential.passwordPlaceholder')}
                    autoComplete="new-password"
                    className="w-full px-3 py-2 pr-9 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-white font-mono focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                    title={showPassword ? t('vault.credential.hidePassword') : t('vault.credential.showPassword')}
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                <CopyButton value={data.password} label={t('vault.credential.copyPassword')} />
                <div className="relative" ref={generatorRef}>
                  <button
                    type="button"
                    onClick={() => setShowGenerator(!showGenerator)}
                    className="p-1.5 rounded-md text-gray-500 hover:text-amber-600 hover:bg-amber-50 dark:text-gray-400 dark:hover:text-amber-400 dark:hover:bg-amber-900/20 transition-colors"
                    title={t('vault.credential.generatePassword')}
                  >
                    <Zap size={16} />
                  </button>
                  {showGenerator && (
                    <div className="absolute right-0 top-full mt-2 z-50">
                      <PasswordGenerator
                        onUse={(pw) => updateField('password', pw)}
                        onClose={() => setShowGenerator(false)}
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Notes section */}
        <div className="space-y-3">
          <h4 className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">
            {t('vault.credential.additionalNotes')}
          </h4>
          <textarea
            value={data.notes}
            onChange={(e) => updateField('notes', e.target.value)}
            placeholder={t('vault.credential.notesPlaceholder')}
            rows={4}
            className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-xl text-sm text-gray-900 dark:text-white resize-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
          />
        </div>
      </form>
    </div>
  );
}
