import i18n, { type TFunction } from 'i18next'; // same global instance the app initializes in src/i18n.ts

type UploadErr = { response?: { status?: number; data?: { message?: string } }; message?: string };

/** Builds the toast text for a failed attachment upload, with a specific reason when known. */
export function uploadErrorText(t: TFunction, err: unknown, name: string): string {
    const e = (err ?? {}) as UploadErr;
    const msg = e.response?.data?.message;
    if (msg === 'QUOTA_EXCEEDED' || e.message === 'QUOTA_EXCEEDED') return t('actions.quotaExceeded');
    if (e.response?.status === 429) return t('notes.uploadFailedReason', { name, reason: t('auth.rateLimitExceeded') });
    if (typeof msg === 'string' && msg.startsWith('errors.') && i18n.exists(msg)) return t('notes.uploadFailedReason', { name, reason: t(msg) });
    return t('notes.uploadFailed', { name });
}
