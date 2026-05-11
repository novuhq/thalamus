export * from './types.js';
export * from './errors.js';
export * from './stream-utils.js';

import { createAnthropicProvider } from './anthropic/index.js';

export const thalamus = {
  anthropic: createAnthropicProvider,
} as const;

export { createAnthropicProvider };
