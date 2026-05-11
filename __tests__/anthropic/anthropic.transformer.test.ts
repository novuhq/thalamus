import { describe, expect, it } from 'vitest';
import { toContentBlocks } from '../../src/anthropic/anthropic.transformer.js';

describe('toContentBlocks', () => {
  it('converts a string to a single text block', () => {
    expect(toContentBlocks('Hello!')).toEqual([
      { type: 'text', text: 'Hello!' },
    ]);
  });

  it('converts a text content part', () => {
    expect(toContentBlocks([{ type: 'text', text: 'Hello!' }])).toEqual([
      { type: 'text', text: 'Hello!' },
    ]);
  });

  it('converts a base64 image content part', () => {
    expect(toContentBlocks([{ type: 'image', data: 'abc123', mediaType: 'image/png' }])).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
    ]);
  });

  it('converts an image-url content part', () => {
    expect(toContentBlocks([{ type: 'image-url', url: 'https://example.com/img.png' }])).toEqual([
      { type: 'image', source: { type: 'url', url: 'https://example.com/img.png' } },
    ]);
  });

  it('converts a file content part to a document block', () => {
    expect(toContentBlocks([{ type: 'file', data: 'cGRmIGRhdGE=', mediaType: 'application/pdf', name: 'report.pdf' }])).toEqual([
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: 'cGRmIGRhdGE=' },
        title: 'report.pdf',
      },
    ]);
  });

  it('sets document title to null when file has no name', () => {
    const result = toContentBlocks([{ type: 'file', data: 'dGV4dA==', mediaType: 'text/plain' }]);
    expect(result[0]).toMatchObject({ type: 'document', title: null });
  });

  it('converts mixed content parts in order', () => {
    const result = toContentBlocks([
      { type: 'text', text: 'Look at this:' },
      { type: 'image', data: 'abc', mediaType: 'image/jpeg' },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ type: 'text' });
    expect(result[1]).toMatchObject({ type: 'image' });
  });
});
