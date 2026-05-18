export {
  type CloudflareBackendOptions,
  cloudflare,
} from "./durable/cloudflare";
export type {
  EdgeObserveParams,
  EdgeObserver,
  SSEFrame,
} from "./durable/types";
export * from "./errors";
export * from "./send-result";
export * from "./types";
export type {
  Credential,
  CredentialInfo,
  Vault,
  VaultOptions,
  VaultStore,
} from "./vault/index";
export { createMemoryVaultStore } from "./vault/index";

import { createAnthropicProvider } from "./anthropic/index";
import { createOpenAIProvider } from "./openai/index";

export const thalamus = {
  anthropic: createAnthropicProvider,
  openai: createOpenAIProvider,
} as const;

export { createAnthropicProvider, createOpenAIProvider };
