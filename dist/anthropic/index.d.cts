export { A as AnthropicProviderConfig, c as createAnthropicProvider } from '../anthropic.provider-jea7nC8x.cjs';
import { BetaManagedAgentsTextBlock, BetaManagedAgentsImageBlock, BetaManagedAgentsDocumentBlock } from '@anthropic-ai/sdk/resources/beta/sessions';
import { g as Message } from '../types-Dt6a3qIc.cjs';
import '../types-D5De32xL.cjs';
import '../vault.interface-BMCawAU1.cjs';

type ContentBlock = BetaManagedAgentsTextBlock | BetaManagedAgentsImageBlock | BetaManagedAgentsDocumentBlock;
/**
 * Converts a Message's content to Anthropic content blocks.
 */
declare function toContentBlocks(content: Message["content"]): ContentBlock[];

export { toContentBlocks };
