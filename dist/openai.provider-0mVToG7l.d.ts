import { e as McpServerConfig, P as Provider } from './types-Bx8FEBkB.js';
import { c as VaultStore } from './vault.interface-BMCawAU1.js';

type OpenAIDirectConfig = {
    apiKey: string;
    awsRegion?: never;
    awsBedrockApiKey?: never;
    awsCredentials?: never;
};
type OpenAIBedrockApiKeyConfig = {
    awsRegion: string;
    awsBedrockApiKey: string;
    apiKey?: never;
    awsCredentials?: never;
};
type OpenAIBedrockSigV4Config = {
    awsRegion: string;
    awsCredentials: {
        accessKeyId: string;
        secretAccessKey: string;
        sessionToken?: string;
    };
    apiKey?: never;
    awsBedrockApiKey?: never;
};
type OpenAIBaseConfig = {
    model?: string;
    promptId?: string;
    instructions?: string;
    mcpServers?: McpServerConfig[];
    vaultStore?: VaultStore;
};
type OpenAIProviderConfig = OpenAIBaseConfig & (OpenAIDirectConfig | OpenAIBedrockApiKeyConfig | OpenAIBedrockSigV4Config);
declare function createOpenAIProvider(config: OpenAIProviderConfig): Provider;

export { type OpenAIProviderConfig as O, createOpenAIProvider as c };
