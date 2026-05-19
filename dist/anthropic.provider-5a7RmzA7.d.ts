import { D as DurableBackend } from './types-BJUMp1Dw.js';
import { j as SessionEventsFactory, P as Provider } from './types-DbphwzOq.js';

type AnthropicProviderConfig = {
    agentId: string;
    environmentId: string;
    onSessionEvents?: SessionEventsFactory;
    durable?: DurableBackend;
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
