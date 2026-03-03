import type { LLMProvider } from './types';
import { AnthropicProvider } from './anthropic.provider';
import { getSetting } from '../settings.service';
import { BadRequestError } from '../../utils/errors';

let cachedProvider: LLMProvider | null = null;
let cachedKey: string | null = null;

export async function getLLMProvider(): Promise<LLMProvider> {
  const apiKey = await getSetting('ai_api_key', '');

  if (!apiKey) {
    throw new BadRequestError('errors.ai.keyNotConfigured');
  }

  // Cache provider instance (recreate if key changed)
  if (cachedProvider && cachedKey === apiKey) {
    return cachedProvider;
  }

  const provider = await getSetting('ai_provider', 'anthropic');

  switch (provider) {
    case 'anthropic':
      cachedProvider = new AnthropicProvider(apiKey);
      cachedKey = apiKey;
      return cachedProvider;
    default:
      throw new BadRequestError('errors.ai.unsupportedProvider');
  }
}

export function clearProviderCache() {
  cachedProvider = null;
  cachedKey = null;
}
