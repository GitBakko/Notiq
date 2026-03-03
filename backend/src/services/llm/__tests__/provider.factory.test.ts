import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestError } from '../../../utils/errors';

// ---------------------------------------------------------------------------
// Mocks — vi.hoisted() runs before vi.mock hoisting, so refs are available
// ---------------------------------------------------------------------------

const { mockGetSetting, mockAnthropicInstances } = vi.hoisted(() => ({
  mockGetSetting: vi.fn<(key: string, defaultValue: string) => Promise<string>>(),
  // Track instances created by the mock class
  mockAnthropicInstances: [] as Array<{ stream: ReturnType<typeof vi.fn> }>,
}));

vi.mock('../../settings.service', () => ({
  getSetting: mockGetSetting,
}));

vi.mock('../anthropic.provider', () => {
  return {
    AnthropicProvider: class MockAnthropicProvider {
      stream = vi.fn();
      apiKey: string;
      constructor(apiKey: string) {
        this.apiKey = apiKey;
        mockAnthropicInstances.push(this);
      }
    },
  };
});

// Import AFTER mocks are set up
import { getLLMProvider, clearProviderCache } from '../provider.factory';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Configure mockGetSetting to return specific values per key.
 */
function configureMockSettings(settings: Record<string, string>) {
  mockGetSetting.mockImplementation(async (key: string, defaultValue: string) => {
    return settings[key] ?? defaultValue;
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('provider.factory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearProviderCache();
    mockAnthropicInstances.length = 0;
  });

  // -------------------------------------------------------------------------
  // T1 — Returns Anthropic provider when AI_PROVIDER=anthropic
  // -------------------------------------------------------------------------
  it('returns AnthropicProvider when ai_provider is "anthropic"', async () => {
    configureMockSettings({
      ai_api_key: 'sk-test-key-123',
      ai_provider: 'anthropic',
    });

    const provider = await getLLMProvider();

    expect(provider).toBeDefined();
    expect(typeof provider.stream).toBe('function');
    expect(mockAnthropicInstances).toHaveLength(1);
    expect((mockAnthropicInstances[0] as Record<string, unknown>).apiKey).toBe('sk-test-key-123');
  });

  // -------------------------------------------------------------------------
  // T2 — Defaults to Anthropic when ai_provider is not set (uses default)
  // -------------------------------------------------------------------------
  it('defaults to AnthropicProvider when ai_provider setting is absent', async () => {
    // Only configure ai_api_key; ai_provider will fall through to default 'anthropic'
    configureMockSettings({
      ai_api_key: 'sk-default-key',
    });

    const provider = await getLLMProvider();

    expect(provider).toBeDefined();
    expect(mockAnthropicInstances).toHaveLength(1);
    expect((mockAnthropicInstances[0] as Record<string, unknown>).apiKey).toBe('sk-default-key');
    // getSetting for ai_provider should have been called with default 'anthropic'
    expect(mockGetSetting).toHaveBeenCalledWith('ai_provider', 'anthropic');
  });

  // -------------------------------------------------------------------------
  // T3 — Throws for unsupported provider type
  // -------------------------------------------------------------------------
  it('throws BadRequestError for unsupported provider', async () => {
    configureMockSettings({
      ai_api_key: 'sk-test-key',
      ai_provider: 'openai',
    });

    await expect(getLLMProvider()).rejects.toThrow(BadRequestError);
    await expect(getLLMProvider()).rejects.toThrow('errors.ai.unsupportedProvider');
  });

  // -------------------------------------------------------------------------
  // T4 — Throws when API key not configured (empty string)
  // -------------------------------------------------------------------------
  it('throws BadRequestError when ai_api_key is empty', async () => {
    configureMockSettings({
      ai_api_key: '',
      ai_provider: 'anthropic',
    });

    await expect(getLLMProvider()).rejects.toThrow(BadRequestError);
    await expect(getLLMProvider()).rejects.toThrow('errors.ai.keyNotConfigured');
  });

  // -------------------------------------------------------------------------
  // T5 — Throws when API key not configured (falls through to default '')
  // -------------------------------------------------------------------------
  it('throws BadRequestError when ai_api_key setting is absent', async () => {
    // No ai_api_key in settings — getSetting will return default ''
    configureMockSettings({
      ai_provider: 'anthropic',
    });

    await expect(getLLMProvider()).rejects.toThrow(BadRequestError);
    await expect(getLLMProvider()).rejects.toThrow('errors.ai.keyNotConfigured');
  });

  // -------------------------------------------------------------------------
  // T6 — Caches provider instance (returns same on second call)
  // -------------------------------------------------------------------------
  it('caches provider instance and reuses on subsequent calls', async () => {
    configureMockSettings({
      ai_api_key: 'sk-cached-key',
      ai_provider: 'anthropic',
    });

    const first = await getLLMProvider();
    const second = await getLLMProvider();

    expect(first).toBe(second);
    // AnthropicProvider should only be constructed once
    expect(mockAnthropicInstances).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // T7 — Recreates provider when API key changes
  // -------------------------------------------------------------------------
  it('recreates provider when api key changes', async () => {
    // First call with key A
    configureMockSettings({
      ai_api_key: 'sk-key-A',
      ai_provider: 'anthropic',
    });
    const first = await getLLMProvider();

    // Second call with key B — should recreate
    configureMockSettings({
      ai_api_key: 'sk-key-B',
      ai_provider: 'anthropic',
    });
    const second = await getLLMProvider();

    expect(second).not.toBe(first);
    expect(mockAnthropicInstances).toHaveLength(2);
    expect((mockAnthropicInstances[0] as Record<string, unknown>).apiKey).toBe('sk-key-A');
    expect((mockAnthropicInstances[1] as Record<string, unknown>).apiKey).toBe('sk-key-B');
  });

  // -------------------------------------------------------------------------
  // T8 — clearProviderCache clears the cache
  // -------------------------------------------------------------------------
  it('clearProviderCache forces re-creation on next call', async () => {
    configureMockSettings({
      ai_api_key: 'sk-same-key',
      ai_provider: 'anthropic',
    });

    const first = await getLLMProvider();
    expect(mockAnthropicInstances).toHaveLength(1);

    // Clear cache — same key, but should still recreate
    clearProviderCache();

    const second = await getLLMProvider();
    expect(second).not.toBe(first);
    expect(mockAnthropicInstances).toHaveLength(2);
  });
});
