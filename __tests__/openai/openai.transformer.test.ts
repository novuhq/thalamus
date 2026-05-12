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

  it('converts a text content part to input_text', () => {
    const messages: Message[] = [
      {
        role: MessageRole.USER,
        content: [{ type: 'text', text: 'Hello there' }],
      },
    ];
    expect(openaiTransformer.toInput(messages)).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Hello there' }] },
    ]);
  });

  it('converts a file content part to input_file with data URI', () => {
    const messages: Message[] = [
      {
        role: MessageRole.USER,
        content: [{ type: 'file', data: 'cGRmIGRhdGE=', mediaType: 'application/pdf', name: 'report.pdf' }],
      },
    ];
    expect(openaiTransformer.toInput(messages)).toEqual([
      {
        role: 'user',
        content: [{
          type: 'input_file',
          file_data: 'data:application/pdf;base64,cGRmIGRhdGE=',
          filename: 'report.pdf',
        }],
      },
    ]);
  });

  it('omits filename when file has no name', () => {
    const messages: Message[] = [
      {
        role: MessageRole.USER,
        content: [{ type: 'file', data: 'dGV4dA==', mediaType: 'text/plain' }],
      },
    ];
    const result = openaiTransformer.toInput(messages);
    expect(result[0].content).toEqual([
      { type: 'input_file', file_data: 'data:text/plain;base64,dGV4dA==' },
    ]);
  });

  it('converts mixed content parts in order', () => {
    const messages: Message[] = [
      {
        role: MessageRole.USER,
        content: [
          { type: 'text', text: 'Check this image and file:' },
          { type: 'image-url', url: 'https://example.com/img.png' },
          { type: 'file', data: 'abc', mediaType: 'application/pdf', name: 'doc.pdf' },
        ],
      },
    ];
    const result = openaiTransformer.toInput(messages);
    const parts = result[0].content as any[];
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatchObject({ type: 'input_text' });
    expect(parts[1]).toMatchObject({ type: 'input_image' });
    expect(parts[2]).toMatchObject({ type: 'input_file' });
  });
});
