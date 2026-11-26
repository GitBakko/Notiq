import { formatDistanceToNow, type Locale } from 'date-fns';

/**
 * Safe wrapper around formatDistanceToNow that clamps future dates to now.
 * Prevents "tra meno di un minuto" (Italian) / "in less than a minute" when
 * server clock is slightly ahead of client.
 */
export const timeAgo = (date: Date | string, locale?: Locale): string => {
  const d = new Date(date);
  const clamped = d.getTime() > Date.now() ? new Date() : d;
  return formatDistanceToNow(clamped, { addSuffix: true, locale });
};

/** Data e ora per l'utente nella lingua dell'app ("3 dic 2026, 12:10"): mai il numerico ambiguo 12/3/2026. Data non valida: stringa vuota. */
export const formatDateTimeMedium = (iso: string, locale?: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(d);
};

export const toDatetimeLocal = (iso: string): string => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

export const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};
