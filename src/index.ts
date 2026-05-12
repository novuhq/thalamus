export * from "./errors";
export * from "./stream-utils";
export * from "./types";

import { createAnthropicProvider } from "./anthropic/index";
import { createOpenAIProvider } from "./openai/index";

export const thalamus = {
  anthropic: createAnthropicProvider,
  openai: createOpenAIProvider,
} as const;

export { createAnthropicProvider, createOpenAIProvider };
