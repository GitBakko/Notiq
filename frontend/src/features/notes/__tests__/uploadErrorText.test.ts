import { describe, it, expect } from 'vitest';
import type { TFunction } from 'i18next';
import '../../../i18n'; // initializes the global i18next instance used by i18n.exists
import { uploadErrorText } from '../uploadErrorText';

const t = ((k: string, o?: Record<string, string>) =>
  o ? `${k}|${Object.values(o).join('|')}` : k) as unknown as TFunction;

describe('uploadErrorText', () => {
  it('429 -> rate limit reason', () => {
    expect(uploadErrorText(t, { response: { status: 429 } }, 'a.pdf')).toBe('notes.uploadFailedReason|a.pdf|auth.rateLimitExceeded');
  });
  it('i18n error key -> reason', () => {
    const err = { response: { status: 400, data: { message: 'errors.attachments.mimeTypeNotAllowed' } } };
    expect(uploadErrorText(t, err, 'a.scncfg')).toBe('notes.uploadFailedReason|a.scncfg|errors.attachments.mimeTypeNotAllowed');
  });
  it('unknown errors.* key -> generic', () => {
    const err = { response: { status: 400, data: { message: 'errors.x.y' } } };
    expect(uploadErrorText(t, err, 'a')).toBe('notes.uploadFailed|a');
  });
  it('QUOTA_EXCEEDED (response or message)', () => {
    expect(uploadErrorText(t, { response: { data: { message: 'QUOTA_EXCEEDED' } } }, 'a')).toBe('actions.quotaExceeded');
    expect(uploadErrorText(t, { message: 'QUOTA_EXCEEDED' }, 'a')).toBe('actions.quotaExceeded');
  });
  it('unknown -> generic', () => {
    expect(uploadErrorText(t, new Error('boom'), 'a')).toBe('notes.uploadFailed|a');
    expect(uploadErrorText(t, undefined, 'a')).toBe('notes.uploadFailed|a');
  });
});
