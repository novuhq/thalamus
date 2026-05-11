export * from './types';
export * from './errors';
export * from './stream-utils';

import { createAnthropicProvider } from './anthropic/index';
import { createOpenAIProvider } from './openai/index';

export const thalamus = {
  anthropic: createAnthropicProvider,
  openai: createOpenAIProvider,
} as const;

export { createAnthropicProvider, createOpenAIProvider };
