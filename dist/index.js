import {
  createAnthropicProvider
} from "./chunk-Z4PRDWGM.js";
import {
  createOpenAIProvider
} from "./chunk-6GLROXWH.js";
import {
  ANTHROPIC,
  CredentialExpiredError,
  McpServerError,
  MessageRole,
  OPENAI,
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderResponseError,
  ProviderUnavailableError,
  SessionExpiredError,
  ThalamusError,
  VaultError,
  VaultNotFoundError,
  createStreamResult
} from "./chunk-LQAFAVC6.js";
import {
  createMemoryVaultStore
} from "./chunk-2CE52QMW.js";
import "./chunk-L5ITO5PR.js";

// src/stream-utils.ts
async function collectStream(result) {
  return result;
}

// src/index.ts
var thalamus = {
  anthropic: createAnthropicProvider,
  openai: createOpenAIProvider
};
export {
  ANTHROPIC,
  CredentialExpiredError,
  McpServerError,
  MessageRole,
  OPENAI,
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderResponseError,
  ProviderUnavailableError,
  SessionExpiredError,
  ThalamusError,
  VaultError,
  VaultNotFoundError,
  collectStream,
  createAnthropicProvider,
  createMemoryVaultStore,
  createOpenAIProvider,
  createStreamResult,
  thalamus
};
//# sourceMappingURL=index.js.map