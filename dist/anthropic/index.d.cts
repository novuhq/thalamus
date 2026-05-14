export { A as AnthropicProviderConfig, c as createAnthropicProvider } from '../anthropic.provider--6ImQWpY.cjs';
import { BetaManagedAgentsTextBlock, BetaManagedAgentsImageBlock, BetaManagedAgentsDocumentBlock } from '@anthropic-ai/sdk/resources/beta/sessions';
import { g as Message } from '../types-J5hdDFqL.cjs';
import '../vault.interface-BMCawAU1.cjs';

type ContentBlock = BetaManagedAgentsTextBlock | BetaManagedAgentsImageBlock | BetaManagedAgentsDocumentBlock;
/**
 * Converts a Message's content to Anthropic content blocks.
 */
declare function toContentBlocks(content: Message["content"]): ContentBlock[];

export { toContentBlocks };
