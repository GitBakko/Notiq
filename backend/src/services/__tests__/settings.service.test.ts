import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../../plugins/prisma';
import { getSetting, setSetting, getBooleanSetting } from '../settings.service';

const prismaMock = prisma as any;

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// getSetting
// ---------------------------------------------------------------------------
describe('getSetting', () => {
  it('returns the value when the setting exists', async () => {
    prismaMock.systemSetting.findUnique.mockResolvedValue({
      key: 'registrationOpen',
      value: 'false',
    });

    const result = await getSetting('registrationOpen');

    expect(prismaMock.systemSetting.findUnique).toHaveBeenCalledWith({
      where: { key: 'registrationOpen' },
    });
    expect(result).toBe('false');
  });

  it('returns the default value when the setting does not exist', async () => {
    prismaMock.systemSetting.findUnique.mockResolvedValue(null);

    const result = await getSetting('missingKey');

    expect(result).toBe('true');
  });

  it('returns a custom default value when provided and setting does not exist', async () => {
    prismaMock.systemSetting.findUnique.mockResolvedValue(null);

    const result = await getSetting('missingKey', 'customDefault');

    expect(result).toBe('customDefault');
  });

  it('returns the stored value even when a custom default is provided', async () => {
    prismaMock.systemSetting.findUnique.mockResolvedValue({
      key: 'maxUploadSize',
      value: '10MB',
    });

    const result = await getSetting('maxUploadSize', '5MB');

    expect(result).toBe('10MB');
  });

  it('returns the stored value when it is an empty string', async () => {
    prismaMock.systemSetting.findUnique.mockResolvedValue({
      key: 'emptyKey',
      value: '',
    });

    const result = await getSetting('emptyKey', 'fallback');

    // Empty string is falsy but ?? only triggers on null/undefined
    expect(result).toBe('');
  });
});

// ---------------------------------------------------------------------------
// setSetting
// ---------------------------------------------------------------------------
describe('setSetting', () => {
  it('upserts a setting with key, value, and description', async () => {
    const setting = { key: 'registrationOpen', value: 'true', description: 'Allow registration' };
    prismaMock.systemSetting.upsert.mockResolvedValue(setting);

    const result = await setSetting('registrationOpen', 'true', 'Allow registration');

    expect(prismaMock.systemSetting.upsert).toHaveBeenCalledWith({
      where: { key: 'registrationOpen' },
      update: { value: 'true', description: 'Allow registration' },
      create: { key: 'registrationOpen', value: 'true', description: 'Allow registration' },
    });
    expect(result).toEqual(setting);
  });

  it('upserts a setting without description', async () => {
    const setting = { key: 'theme', value: 'dark', description: undefined };
    prismaMock.systemSetting.upsert.mockResolvedValue(setting);

    const result = await setSetting('theme', 'dark');

    expect(prismaMock.systemSetting.upsert).toHaveBeenCalledWith({
      where: { key: 'theme' },
      update: { value: 'dark', description: undefined },
      create: { key: 'theme', value: 'dark', description: undefined },
    });
    expect(result).toEqual(setting);
  });

  it('updates an existing setting (upsert behavior)', async () => {
    const updated = { key: 'registrationOpen', value: 'false', description: 'Closed' };
    prismaMock.systemSetting.upsert.mockResolvedValue(updated);

    const result = await setSetting('registrationOpen', 'false', 'Closed');

    expect(result).toEqual(updated);
  });
});

// ---------------------------------------------------------------------------
// getBooleanSetting
// ---------------------------------------------------------------------------
describe('getBooleanSetting', () => {
  it('returns true when stored value is "true"', async () => {
    prismaMock.systemSetting.findUnique.mockResolvedValue({
      key: 'registrationOpen',
      value: 'true',
    });

    const result = await getBooleanSetting('registrationOpen');

    expect(result).toBe(true);
  });

  it('returns false when stored value is "false"', async () => {
    prismaMock.systemSetting.findUnique.mockResolvedValue({
      key: 'registrationOpen',
      value: 'false',
    });

    const result = await getBooleanSetting('registrationOpen');

    expect(result).toBe(false);
  });

  it('returns false for any non-"true" string value', async () => {
    prismaMock.systemSetting.findUnique.mockResolvedValue({
      key: 'someFlag',
      value: 'yes',
    });

    const result = await getBooleanSetting('someFlag');

    expect(result).toBe(false);
  });

  it('returns true (default) when setting does not exist and no default provided', async () => {
    prismaMock.systemSetting.findUnique.mockResolvedValue(null);

    const result = await getBooleanSetting('missingFlag');

    expect(result).toBe(true);
  });

  it('returns false when setting does not exist and default is false', async () => {
    prismaMock.systemSetting.findUnique.mockResolvedValue(null);

    const result = await getBooleanSetting('missingFlag', false);

    expect(result).toBe(false);
  });

  it('returns true when setting does not exist and default is explicitly true', async () => {
    prismaMock.systemSetting.findUnique.mockResolvedValue(null);

    const result = await getBooleanSetting('missingFlag', true);

    expect(result).toBe(true);
  });

  it('returns false when stored value is an empty string', async () => {
    prismaMock.systemSetting.findUnique.mockResolvedValue({
      key: 'emptyFlag',
      value: '',
    });

    const result = await getBooleanSetting('emptyFlag');

    // '' === 'true' is false
    expect(result).toBe(false);
  });
});
