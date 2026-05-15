import { D as DurabilityBackend, E as EdgeObserver } from './types-Dj7j5_Vh.js';
import { j as SessionEventsFactory, P as Provider } from './types-D03ofbVu.js';

type AnthropicProviderConfig = {
    agentId: string;
    environmentId: string;
    onSessionEvents?: SessionEventsFactory;
    durable?: DurabilityBackend;
    edgeObserver?: EdgeObserver;
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
