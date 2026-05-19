export { A as AnthropicProviderConfig, c as createAnthropicProvider } from '../anthropic.provider-5a7RmzA7.js';
import { BetaManagedAgentsTextBlock, BetaManagedAgentsImageBlock, BetaManagedAgentsDocumentBlock, BetaManagedAgentsStreamSessionEvents } from '@anthropic-ai/sdk/resources/beta/sessions';
import { g as Message, i as Response, U as Usage, c as ActionRequired, S as StreamPart } from '../types-DbphwzOq.js';
import '../types-BJUMp1Dw.js';
import '../vault.interface-BMCawAU1.js';

type ContentBlock = BetaManagedAgentsTextBlock | BetaManagedAgentsImageBlock | BetaManagedAgentsDocumentBlock;
/**
 * Converts a Message's content to Anthropic content blocks.
 */
declare function toContentBlocks(content: Message["content"]): ContentBlock[];

declare class ResponseAccumulator {
    content: string;
    finishReason: Response["finishReason"];
    usage: Usage | undefined;
    actionsRequired: ActionRequired[];
    done: boolean;
    toResponse(sessionId: string): Response;
}
declare function mapEvent(event: BetaManagedAgentsStreamSessionEvents, acc: ResponseAccumulator): Generator<StreamPart>;

export { ResponseAccumulator as AnthropicResponseAccumulator, mapEvent as mapAnthropicEvent, toContentBlocks };
