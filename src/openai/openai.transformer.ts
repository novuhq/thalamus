import {
  MessageRole,
  type Message,
  type ContentPart,
} from '../types';

type OpenAIInputContent =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: { url: string } }
  | { type: 'input_file'; file_data: string; filename?: string };

type OpenAIInputMessage = {
  role: 'user' | 'system' | 'assistant';
  content: string | OpenAIInputContent[];
};

export const openaiTransformer = {
  toInput(messages: Message[]): OpenAIInputMessage[] {
    return messages.map((msg) => {
      const role =
        msg.role === MessageRole.USER ? 'user'
        : msg.role === MessageRole.SYSTEM ? 'system'
        : 'assistant';

      if (typeof msg.content === 'string') return { role, content: msg.content } as OpenAIInputMessage;

      const parts: OpenAIInputContent[] = [];
      for (const part of msg.content) {
        switch (part.type) {
          case 'text':
            parts.push({ type: 'input_text', text: part.text });
            break;
          case 'image-url':
            parts.push({ type: 'input_image', image_url: { url: part.url } });
            break;
          case 'image':
            parts.push({ type: 'input_image', image_url: { url: `data:${part.mediaType};base64,${part.data}` } });
            break;
          case 'file':
            parts.push({
              type: 'input_file',
              file_data: `data:${part.mediaType};base64,${part.data}`,
              ...(part.name ? { filename: part.name } : {}),
            });
            break;
        }
      }

      return { role, content: parts } as OpenAIInputMessage;
    });
  },
};
