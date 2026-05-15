import { D as DurabilityBackend, E as EdgeObserver } from './types-Dj7j5_Vh.cjs';
import { e as McpServerConfig, j as SessionEventsFactory, P as Provider } from './types-Dt6a3qIc.cjs';
import { c as VaultStore } from './vault.interface-BMCawAU1.cjs';

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
    onSessionEvents?: SessionEventsFactory;
    durable?: DurabilityBackend;
    edgeObserver?: EdgeObserver;
};
type OpenAIProviderConfig = OpenAIBaseConfig & (OpenAIDirectConfig | OpenAIBedrockApiKeyConfig | OpenAIBedrockSigV4Config);
declare function createOpenAIProvider(config: OpenAIProviderConfig): Provider;

export { type OpenAIProviderConfig as O, createOpenAIProvider as c };
