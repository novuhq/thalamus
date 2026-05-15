import { S as StreamPart, a as StreamCallbacks, b as SendResult } from './types-Dt6a3qIc.cjs';
export { A as ANTHROPIC, c as ActionRequired, d as AgentStatus, C as ContentPart, M as McpApprovalPolicy, e as McpServerConfig, f as McpToolDef, g as Message, h as MessageRole, O as OPENAI, P as Provider, R as RequestParams, i as Response, j as SessionEventsFactory, k as SessionOptions, T as ToolResult, l as ToolSource, U as Usage } from './types-Dt6a3qIc.cjs';
export { C as Credential, a as CredentialInfo, V as Vault, b as VaultOptions, c as VaultStore } from './vault.interface-BMCawAU1.cjs';
export { c as createMemoryVaultStore } from './memory-vault-store-BoD8Nj7J.cjs';
import { c as createAnthropicProvider } from './anthropic.provider-C1pEA7Aw.cjs';
import { c as createOpenAIProvider } from './openai.provider-CgA3zeDP.cjs';
import './types-Dj7j5_Vh.cjs';

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
declare class AbortedError extends ThalamusError {
    readonly sessionId?: string;
    constructor(options: {
        provider: string;
        sessionId?: string;
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

interface SendResultOptions {
    autoStart?: boolean;
}
declare function createSendResult(source: AsyncIterable<StreamPart>, callbacks?: StreamCallbacks, options?: SendResultOptions): SendResult;

declare const thalamus: {
    readonly anthropic: typeof createAnthropicProvider;
    readonly openai: typeof createOpenAIProvider;
};

export { AbortedError, CredentialExpiredError, McpServerError, ProviderAuthError, ProviderRateLimitError, ProviderResponseError, ProviderUnavailableError, SendResult, type SendResultOptions, SessionExpiredError, StreamCallbacks, StreamPart, ThalamusError, VaultError, VaultNotFoundError, createAnthropicProvider, createOpenAIProvider, createSendResult, thalamus };
