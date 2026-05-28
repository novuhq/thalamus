export {
  type CloudflareBackendOptions,
  cloudflare,
} from "./durable/cloudflare";
export type {
  EdgeObserveParams,
  EdgeObserver,
} from "./durable/types";
export * from "./errors";
export type {
  LogContext,
  PinoLike,
  ThalamusLogger,
  ThalamusLoggerInput,
} from "./logger";
export {
  adaptPinoLogger,
  createConsoleLogger,
  logErrorMessage,
  resolveLogger,
  silentLogger,
} from "./logger";
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
