import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderAuthError } from '../../src/errors.js';
import { createOpenAIProvider } from '../../src/openai/openai.provider.js';
import { collectStream } from '../../src/stream-utils.js';

function makeStream(events: object[]) {
  return { [Symbol.asyncIterator]: async function* () { for (const e of events) yield e; } };
}

const mockResponsesCreate = vi.fn();

vi.mock('openai', () => {
  const MockOpenAI = function () {
    return { responses: { create: mockResponsesCreate } };
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

describe('stream — new session', () => {
  it('yields stream-start, text-delta events, resolves response with sessionId', async () => {
    mockResponsesCreate.mockReturnValue(
      makeStream([
        { type: 'response.created', response: { id: 'resp_1' } },
        { type: 'response.output_text.delta', delta: 'Hello' },
        { type: 'response.output_text.delta', delta: ' world' },
        {
          type: 'response.completed',
          response: {
            id: 'resp_1',
            output: [{ content: [{ text: 'Hello world' }] }],
            usage: { input_tokens: 5, output_tokens: 2 },
          },
        },
      ]),
    );

    const result = await createOpenAIProvider(config).stream({
      message: { role: 'user', content: 'Hi' } as never,
    });

    const parts = [];
    for await (const p of result.stream) parts.push(p);

    expect(parts.find((p) => p.type === 'stream-start')).toMatchObject({ sessionId: 'resp_1' });
    expect(parts.filter((p) => p.type === 'text-delta')).toHaveLength(2);

    const response = await result.response;
    expect(response.content).toBe('Hello world');
    expect(response.sessionId).toBe('resp_1');
    expect(response.usage?.inputTokens).toBe(5);
  });
});

describe('stream — resume session', () => {
  it('passes previous_response_id when sessionId is provided', async () => {
    mockResponsesCreate.mockReturnValue(
      makeStream([
        { type: 'response.created', response: { id: 'resp_2' } },
        { type: 'response.completed', response: { id: 'resp_2', output: [{ content: [{ text: 'ok' }] }], usage: {} } },
      ]),
    );

    await collectStream(
      await createOpenAIProvider(config).stream({
        message: { role: 'user', content: 'next' } as never,
        sessionId: 'resp_prev',
      }),
    );

    expect(mockResponsesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ previous_response_id: 'resp_prev' }),
    );
  });
});

describe('history seeding', () => {
  it('prepends history to input when no sessionId', async () => {
    mockResponsesCreate.mockReturnValue(
      makeStream([
        { type: 'response.created', response: { id: 'resp_3' } },
        { type: 'response.completed', response: { id: 'resp_3', output: [], usage: {} } },
      ]),
    );

    await collectStream(
      await createOpenAIProvider(config).stream({
        message: { role: 'user', content: 'current' } as never,
        history: [{ role: 'user', content: 'prior' } as never],
      }),
    );

    const callInput = mockResponsesCreate.mock.calls[0][0].input;
    expect(callInput).toHaveLength(2);
  });
});

describe('error handling', () => {
  it('maps invalid_api_key to ProviderAuthError', async () => {
    mockResponsesCreate.mockReturnValue(
      makeStream([{ type: 'error', message: 'Incorrect API key', code: 'invalid_api_key' }]),
    );

    const result = await createOpenAIProvider(config).stream({
      message: { role: 'user', content: 'x' } as never,
    });
    const parts = [];
    for await (const p of result.stream) parts.push(p);

    expect((parts.find((p) => p.type === 'error') as any)?.error).toBeInstanceOf(ProviderAuthError);
    await expect(result.response).rejects.toBeInstanceOf(ProviderAuthError);
  });
});
