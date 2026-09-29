import path from 'path';

export const UPLOADS_DIR = path.join(__dirname, '../../uploads');

/**
 * The ONLY image mimetypes an upload route may accept, each mapped to the extension the
 * file is stored with. Deriving the extension from the validated mimetype — never from
 * the client-supplied filename — is what stops a caller from parking a `.svg` (an active
 * document) on an unauthenticated same-origin /uploads URL.
 */
export const IMAGE_MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

export function extensionForImageMime(mimetype: string): string | null {
  return IMAGE_MIME_EXTENSIONS[mimetype] ?? null;
}

/**
 * Map a stored public URL (`/uploads/...`) to an absolute path inside UPLOADS_DIR.
 * Returns null for anything that is not an uploads URL or that escapes the directory.
 */
export function resolveUploadPath(url: string | null | undefined): string | null {
  if (!url || !url.startsWith('/uploads/')) return null;
  const abs = path.resolve(UPLOADS_DIR, url.slice('/uploads/'.length));
  if (abs !== UPLOADS_DIR && !abs.startsWith(UPLOADS_DIR + path.sep)) return null;
  return abs;
}
