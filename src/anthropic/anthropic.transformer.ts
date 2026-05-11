import type {
  BetaManagedAgentsTextBlock,
  BetaManagedAgentsImageBlock,
  BetaManagedAgentsDocumentBlock,
} from '@anthropic-ai/sdk/resources/beta/sessions';
import type { Message } from '../types.js';

type ContentBlock = BetaManagedAgentsTextBlock | BetaManagedAgentsImageBlock | BetaManagedAgentsDocumentBlock;

/**
 * Converts a Message's content to Anthropic content blocks.
 */
export function toContentBlocks(content: Message['content']): ContentBlock[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }

  const blocks: ContentBlock[] = [];
  for (const part of content) {
    switch (part.type) {
      case 'text':
        blocks.push({ type: 'text', text: part.text });
        break;
      case 'image':
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: part.mediaType, data: part.data },
        });
        break;
      case 'image-url':
        blocks.push({ type: 'image', source: { type: 'url', url: part.url } });
        break;
      case 'file':
        blocks.push({
          type: 'document',
          source: { type: 'base64', media_type: part.mediaType, data: part.data },
          title: part.name ?? null,
        });
        break;
    }
  }

  return blocks;
}
