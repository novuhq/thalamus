import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderAuthError } from '../../src/errors.js';
import { createOpenAIProvider } from '../../src/openai/openai.provider.js';
import { collectStream } from '../../src/stream-utils.js';

function makeStream(events: object[]) {
  return { [Symbol.asyncIterator]: async function* () { for (const e of events) yield e; } };
}

const mockResponsesCreate = vi.fn();
const mockConversationsCreate = vi.fn();

vi.mock('openai', () => {
  const MockOpenAI = function () {
    return {
      responses: { create: mockResponsesCreate },
      conversations: { create: mockConversationsCreate },
    };
  };
  return { default: MockOpenAI };
});

afterEach(() => vi.clearAllMocks());

const config = { apiKey: 'sk-test', model: 'gpt-4o', instructions: 'Be helpful.' };

describe('createOpenAIProvider', () => {
  it('sets provider = openai and runtimeId = inline when no promptId', () => {
    const rt = createOpenAIProvider(config);
    expect(rt.provider).toBe('openai');
    expect(rt.runtimeId).toBe('inline');
  });

  it('uses promptId as runtimeId when provided', () => {
    expect(createOpenAIProvider({ ...config, promptId: 'pmpt_abc' }).runtimeId).toBe('pmpt_abc');
  });
});

describe('stream — new session (conversation)', () => {
  it('creates a conversation, yields stream-start with conversationId, resolves response', async () => {
    mockConversationsCreate.mockResolvedValue({ id: 'conv_new' });
    mockResponsesCreate.mockReturnValue(
      makeStream([
        { type: 'response.created', response: { id: 'resp_1', conversation: { id: 'conv_new' } } },
        { type: 'response.output_text.delta', delta: 'Hello' },
        { type: 'response.output_text.delta', delta: ' world' },
        {
          type: 'response.completed',
          response: {
            id: 'resp_1',
            output_text: 'Hello world',
            usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
          },
        },
      ]),
    );

    const result = await createOpenAIProvider(config).stream({
      messages: [{ role: 'user', content: 'Hi' } as never],
    });

    const parts = [];
    for await (const p of result.stream) parts.push(p);

    expect(mockConversationsCreate).toHaveBeenCalledOnce();
    expect(parts.find((p) => p.type === 'stream-start')).toMatchObject({ sessionId: 'conv_new' });
    expect(parts.filter((p) => p.type === 'text-delta')).toHaveLength(2);

    const response = await result.response;
    expect(response.content).toBe('Hello world');
    expect(response.sessionId).toBe('conv_new');
    expect(response.usage?.inputTokens).toBe(5);
  });
});

describe('stream — resume session (conversation)', () => {
  it('passes conversation id when sessionId is provided, skips conversations.create', async () => {
    mockResponsesCreate.mockReturnValue(
      makeStream([
        { type: 'response.created', response: { id: 'resp_2', conversation: { id: 'conv_existing' } } },
        { type: 'response.completed', response: { id: 'resp_2', output_text: 'ok', usage: {} } },
      ]),
    );

    await collectStream(
      await createOpenAIProvider(config).stream({
        messages: [{ role: 'user', content: 'next' } as never],
        sessionId: 'conv_existing',
      }),
    );

    expect(mockConversationsCreate).not.toHaveBeenCalled();
    expect(mockResponsesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ conversation: { id: 'conv_existing' } }),
    );
  });
});

describe('multiple messages', () => {
  it('passes all messages as input', async () => {
    mockConversationsCreate.mockResolvedValue({ id: 'conv_hist' });
    mockResponsesCreate.mockReturnValue(
      makeStream([
        { type: 'response.created', response: { id: 'resp_3', conversation: { id: 'conv_hist' } } },
        { type: 'response.completed', response: { id: 'resp_3', output_text: '', usage: {} } },
      ]),
    );

    await collectStream(
      await createOpenAIProvider(config).stream({
        messages: [
          { role: 'system', content: 'You are helpful' } as never,
          { role: 'user', content: 'current' } as never,
        ],
      }),
    );

    const callInput = mockResponsesCreate.mock.calls[0][0].input;
    expect(callInput).toHaveLength(2);
  });
});

describe('tool call streaming', () => {
  it('emits tool-use-start, tool-use-delta, tool-use-done in sequence', async () => {
    mockConversationsCreate.mockResolvedValue({ id: 'conv_tool' });
    mockResponsesCreate.mockReturnValue(
      makeStream([
        { type: 'response.created', response: { id: 'resp_t', conversation: { id: 'conv_tool' } } },
        {
          type: 'response.output_item.added',
          item: { type: 'function_call', name: 'get_weather', call_id: 'call_1' },
          output_index: 0,
          sequence_number: 1,
        },
        { type: 'response.function_call_arguments.delta', delta: '{"lo', item_id: 'call_1', output_index: 0, sequence_number: 2 },
        { type: 'response.function_call_arguments.delta', delta: 'c":"NYC"}', item_id: 'call_1', output_index: 0, sequence_number: 3 },
        {
          type: 'response.output_item.done',
          item: { type: 'function_call', name: 'get_weather', call_id: 'call_1', arguments: '{"loc":"NYC"}' },
          output_index: 0,
          sequence_number: 4,
        },
        { type: 'response.completed', response: { id: 'resp_t', output_text: '', usage: {} } },
      ]),
    );

    const result = await createOpenAIProvider(config).stream({
      messages: [{ role: 'user', content: 'weather?' } as never],
    });
    const parts = [];
    for await (const p of result.stream) parts.push(p);

    const toolParts = parts.filter((p) =>
      p.type === 'tool-use-start' || p.type === 'tool-use-delta' || p.type === 'tool-use-done',
    );
    expect(toolParts).toEqual([
      { type: 'tool-use-start', toolName: 'get_weather', toolUseId: 'call_1' },
      { type: 'tool-use-delta', toolUseId: 'call_1', argumentsDelta: '{"lo' },
      { type: 'tool-use-delta', toolUseId: 'call_1', argumentsDelta: 'c":"NYC"}' },
      { type: 'tool-use-done', toolName: 'get_weather', toolUseId: 'call_1', input: { loc: 'NYC' } },
    ]);
  });
});

describe('refusal handling', () => {
  it('emits refusal parts and sets finishReason to refused', async () => {
    mockConversationsCreate.mockResolvedValue({ id: 'conv_ref' });
    mockResponsesCreate.mockReturnValue(
      makeStream([
        { type: 'response.created', response: { id: 'resp_r', conversation: { id: 'conv_ref' } } },
        { type: 'response.refusal.delta', delta: 'I cannot', item_id: 'item_1', content_index: 0, output_index: 0, sequence_number: 1 },
        { type: 'response.refusal.delta', delta: ' help with that.', item_id: 'item_1', content_index: 0, output_index: 0, sequence_number: 2 },
        { type: 'response.completed', response: { id: 'resp_r', output_text: '', usage: {} } },
      ]),
    );

    const result = await createOpenAIProvider(config).stream({
      messages: [{ role: 'user', content: 'do something bad' } as never],
    });
    const parts = [];
    for await (const p of result.stream) parts.push(p);

    expect(parts.filter((p) => p.type === 'refusal')).toEqual([
      { type: 'refusal', text: 'I cannot' },
      { type: 'refusal', text: ' help with that.' },
    ]);

    const response = await result.response;
    expect(response.finishReason).toBe('refused');
  });
});

describe('error handling', () => {
  it('maps invalid_api_key to ProviderAuthError', async () => {
    mockConversationsCreate.mockResolvedValue({ id: 'conv_err' });
    mockResponsesCreate.mockReturnValue(
      makeStream([{ type: 'error', message: 'Incorrect API key', code: 'invalid_api_key' }]),
    );

    const result = await createOpenAIProvider(config).stream({
      messages: [{ role: 'user', content: 'x' } as never],
    });
    const parts = [];
    for await (const p of result.stream) parts.push(p);

    expect((parts.find((p) => p.type === 'error') as any)?.error).toBeInstanceOf(ProviderAuthError);
    await expect(result.response).rejects.toBeInstanceOf(ProviderAuthError);
  });
});
