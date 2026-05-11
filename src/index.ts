export * from './types.js';
export * from './errors.js';
export * from './stream-utils.js';

import { createAnthropicProvider } from './anthropic/index.js';
import { createOpenAIProvider } from './openai/index.js';

export const thalamus = {
  anthropic: createAnthropicProvider,
  openai: createOpenAIProvider,
} as const;

export { createAnthropicProvider, createOpenAIProvider };
