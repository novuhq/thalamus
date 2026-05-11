import { describe, expect, it } from 'vitest';
import { openaiTransformer } from '../../src/openai/openai.transformer.js';
import { MessageRole } from '../../src/types.js';
import type { Message } from '../../src/types.js';

describe('openaiTransformer.toInput', () => {
  it('converts a USER text message', () => {
    const messages: Message[] = [
      { role: MessageRole.USER, content: 'Hello' },
    ];
    expect(openaiTransformer.toInput(messages)).toEqual([
      { role: 'user', content: 'Hello' },
    ]);
  });

  it('preserves SYSTEM messages with role = system', () => {
    const messages: Message[] = [
      { role: MessageRole.SYSTEM, content: 'Be helpful' },
    ];
    expect(openaiTransformer.toInput(messages)).toEqual([
      { role: 'system', content: 'Be helpful' },
    ]);
  });

  it('preserves ASSISTANT messages (OpenAI uses them for history)', () => {
    const messages: Message[] = [
      { role: MessageRole.ASSISTANT, content: 'Prior answer' },
    ];
    expect(openaiTransformer.toInput(messages)).toEqual([
      { role: 'assistant', content: 'Prior answer' },
    ]);
  });

  it('converts image-url to input_image', () => {
    const messages: Message[] = [
      {
        role: MessageRole.USER,
        content: [{ type: 'image-url', url: 'https://example.com/img.jpg' }],
      },
    ];
    expect(openaiTransformer.toInput(messages)).toEqual([
      { role: 'user', content: [{ type: 'input_image', image_url: { url: 'https://example.com/img.jpg' } }] },
    ]);
  });

  it('converts base64 image to data URI', () => {
    const messages: Message[] = [
      {
        role: MessageRole.USER,
        content: [{ type: 'image', data: 'abc123', mediaType: 'image/jpeg' }],
      },
    ];
    expect(openaiTransformer.toInput(messages)).toEqual([
      { role: 'user', content: [{ type: 'input_image', image_url: { url: 'data:image/jpeg;base64,abc123' } }] },
    ]);
  });
});
