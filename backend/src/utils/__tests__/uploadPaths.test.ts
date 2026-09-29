import { describe, it, expect } from 'vitest';
import path from 'path';
import { UPLOADS_DIR, extensionForImageMime, resolveUploadPath } from '../uploadPaths';

// 6.3 — the kanban cover/avatar routes took the stored file's extension from the
// CLIENT filename (`path.extname(data.filename)`), not from the validated mimetype:
// a PNG-typed upload named payload.svg was stored and served as an .svg.
describe('extensionForImageMime', () => {
  it('maps every allowed image mimetype to a canonical extension', () => {
    expect(extensionForImageMime('image/jpeg')).toBe('.jpg');
    expect(extensionForImageMime('image/png')).toBe('.png');
    expect(extensionForImageMime('image/gif')).toBe('.gif');
    expect(extensionForImageMime('image/webp')).toBe('.webp');
  });

  it('rejects mimetypes that are not on the allowlist', () => {
    expect(extensionForImageMime('image/svg+xml')).toBeNull();
    expect(extensionForImageMime('text/html')).toBeNull();
    expect(extensionForImageMime('application/octet-stream')).toBeNull();
    expect(extensionForImageMime('')).toBeNull();
  });
});

describe('resolveUploadPath', () => {
  it('resolves a stored public url to an absolute path under UPLOADS_DIR', () => {
    expect(resolveUploadPath('/uploads/kanban/abc.png')).toBe(path.join(UPLOADS_DIR, 'kanban', 'abc.png'));
    expect(resolveUploadPath('/uploads/kanban/avatars/abc.webp')).toBe(
      path.join(UPLOADS_DIR, 'kanban', 'avatars', 'abc.webp'),
    );
  });

  it('returns null for null, empty and non-upload urls', () => {
    expect(resolveUploadPath(null)).toBeNull();
    expect(resolveUploadPath(undefined)).toBeNull();
    expect(resolveUploadPath('')).toBeNull();
    expect(resolveUploadPath('https://evil.example/uploads/x.png')).toBeNull();
    expect(resolveUploadPath('/etc/passwd')).toBeNull();
  });

  it('returns null for traversal attempts that escape UPLOADS_DIR', () => {
    expect(resolveUploadPath('/uploads/../../../etc/passwd')).toBeNull();
    expect(resolveUploadPath('/uploads/kanban/../../../secrets.env')).toBeNull();
  });
});
