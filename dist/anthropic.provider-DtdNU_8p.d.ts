import { P as Provider } from './types-Bx8FEBkB.js';

type AnthropicProviderConfig = {
    agentId: string;
    environmentId: string;
} & ({
    apiKey: string;
    awsRegion?: never;
    awsWorkspaceId?: never;
} | {
    awsRegion: string;
    awsWorkspaceId?: string;
    apiKey?: never;
});
declare function createAnthropicProvider(config: AnthropicProviderConfig): Provider;

export { type AnthropicProviderConfig as A, createAnthropicProvider as c };
