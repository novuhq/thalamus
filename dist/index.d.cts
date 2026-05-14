import { S as StreamPart, a as StreamCallbacks, b as StreamResult, R as Response } from './types-J5hdDFqL.cjs';
export { A as ANTHROPIC, c as ActionRequired, d as AgentStatus, C as ContentPart, M as McpApprovalPolicy, e as McpServerConfig, f as McpToolDef, g as Message, h as MessageRole, O as OPENAI, P as Provider, i as RequestParams, j as SessionOptions, T as ToolResult, k as ToolSource, U as Usage } from './types-J5hdDFqL.cjs';
export { C as Credential, a as CredentialInfo, V as Vault, b as VaultOptions, c as VaultStore } from './vault.interface-BMCawAU1.cjs';
export { c as createMemoryVaultStore } from './memory-vault-store-BoD8Nj7J.cjs';
import { c as createAnthropicProvider } from './anthropic.provider--6ImQWpY.cjs';
import { c as createOpenAIProvider } from './openai.provider-Bb8JZh7G.cjs';

declare class ThalamusError extends Error {
    readonly provider: string;
    readonly isRetryable: boolean;
    readonly cause?: unknown;
    constructor(message: string, options: {
        provider: string;
        isRetryable: boolean;
        cause?: unknown;
    });
}
declare class ProviderAuthError extends ThalamusError {
    constructor(message: string, options: {
        provider: string;
        cause?: unknown;
    });
}
declare class ProviderRateLimitError extends ThalamusError {
    readonly retryAfterMs?: number;
    constructor(message: string, options: {
        provider: string;
        retryAfterMs?: number;
        cause?: unknown;
    });
}
declare class ProviderUnavailableError extends ThalamusError {
    constructor(message: string, options: {
        provider: string;
        cause?: unknown;
    });
}
declare class ProviderResponseError extends ThalamusError {
    constructor(message: string, options: {
        provider: string;
        cause?: unknown;
    });
}
declare class SessionExpiredError extends ThalamusError {
    readonly sessionId: string;
    constructor(message: string, options: {
        provider: string;
        sessionId: string;
        cause?: unknown;
    });
}
declare class VaultError extends ThalamusError {
    constructor(message: string, options: {
        provider: string;
        cause?: unknown;
    });
}
declare class VaultNotFoundError extends VaultError {
    readonly vaultId: string;
    constructor(vaultId: string, options: {
        provider: string;
        cause?: unknown;
    });
}
declare class CredentialExpiredError extends VaultError {
    readonly serverName: string;
    readonly vaultId: string;
    constructor(serverName: string, vaultId: string, options: {
        provider: string;
        cause?: unknown;
    });
}
declare class McpServerError extends ThalamusError {
    readonly serverName: string;
    readonly statusCode?: number;
    constructor(serverName: string, options: {
        provider: string;
        statusCode?: number;
        cause?: unknown;
    });
}

declare function createStreamResult(source: AsyncIterable<StreamPart>, callbacks?: StreamCallbacks): StreamResult;

/** @deprecated Use `await provider.stream(params)` instead. */
declare function collectStream(result: StreamResult): Promise<Response>;

declare const thalamus: {
    readonly anthropic: typeof createAnthropicProvider;
    readonly openai: typeof createOpenAIProvider;
};

export { CredentialExpiredError, McpServerError, ProviderAuthError, ProviderRateLimitError, ProviderResponseError, ProviderUnavailableError, Response, SessionExpiredError, StreamCallbacks, StreamPart, StreamResult, ThalamusError, VaultError, VaultNotFoundError, collectStream, createAnthropicProvider, createOpenAIProvider, createStreamResult, thalamus };
