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

export const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};
