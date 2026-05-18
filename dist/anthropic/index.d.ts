export { A as AnthropicProviderConfig, c as createAnthropicProvider } from '../anthropic.provider-CiKTjtvq.js';
import { BetaManagedAgentsTextBlock, BetaManagedAgentsImageBlock, BetaManagedAgentsDocumentBlock } from '@anthropic-ai/sdk/resources/beta/sessions';
import { g as Message } from '../types-D03ofbVu.js';
import '../types-D5De32xL.js';
import '../vault.interface-BMCawAU1.js';

type ContentBlock = BetaManagedAgentsTextBlock | BetaManagedAgentsImageBlock | BetaManagedAgentsDocumentBlock;
/**
 * Converts a Message's content to Anthropic content blocks.
 */
declare function toContentBlocks(content: Message["content"]): ContentBlock[];

export { toContentBlocks };
