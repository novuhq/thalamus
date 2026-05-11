import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAnthropicProvider } from '../../src/anthropic/anthropic.provider.js';
import { ThalamusError } from '../../src/errors.js';
import { collectStream } from '../../src/stream-utils.js';

function mockSse(events: object[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e;
    },
  };
}

const mockCreate = vi.fn();
const mockSseStream = vi.fn();
const mockSend = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  const MockAnthropic = function () {
    return {
      beta: {
        sessions: {
          create: mockCreate,
          events: { stream: mockSseStream, send: mockSend },
        },
      },
    };
  };
  return { default: MockAnthropic };
});

afterEach(() => vi.clearAllMocks());

const config = { apiKey: 'sk-test', agentId: 'agent_abc', environmentId: 'env_xyz' };

describe('createAnthropicProvider', () => {
  it('sets provider = anthropic and runtimeId = agentId', () => {
    const rt = createAnthropicProvider(config);
    expect(rt.provider).toBe('anthropic');
    expect(rt.runtimeId).toBe('agent_abc');
  });
});

describe('stream — new session', () => {
  it('creates a session, yields stream-start + text-delta + finish, resolves response', async () => {
    mockCreate.mockResolvedValue({ id: 'sess_new' });
    mockSseStream.mockResolvedValue(
      mockSse([
        { type: 'agent.message', id: 'evt_1', content: [{ type: 'text', text: 'Hello!' }] },
        { type: 'session.status_idle', id: 'evt_2', stop_reason: { type: 'end_turn' } },
      ]),
    );
    mockSend.mockResolvedValue({});

    const rt = createAnthropicProvider(config);
    const result = await rt.stream({
      message: { role: 'user', content: 'Hi' } as never,
    });

    const parts = [];
    for await (const part of result.stream) parts.push(part);

    expect(mockCreate).toHaveBeenCalledOnce();
    expect(mockSend).toHaveBeenCalledOnce();
    expect(parts.find((p) => p.type === 'stream-start')).toMatchObject({ sessionId: 'sess_new' });
    expect(parts.find((p) => p.type === 'text-delta')).toMatchObject({ text: 'Hello!' });
    expect(parts.find((p) => p.type === 'finish')).toBeDefined();

    const response = await result.response;
    expect(response.content).toBe('Hello!');
    expect(response.sessionId).toBe('sess_new');
    expect(response.finishReason).toBe('stop');
  });
});

describe('stream — resume session', () => {
  it('skips session creation when sessionId is provided', async () => {
    mockSseStream.mockResolvedValue(
      mockSse([
        { type: 'agent.message', id: 'evt_1', content: [{ type: 'text', text: 'Continued.' }] },
        { type: 'session.status_idle', id: 'evt_2', stop_reason: { type: 'end_turn' } },
      ]),
    );
    mockSend.mockResolvedValue({});

    const rt = createAnthropicProvider(config);
    await collectStream(
      await rt.stream({
        message: { role: 'user', content: 'next' } as never,
        sessionId: 'sess_existing',
      }),
    );

    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSseStream).toHaveBeenCalledWith('sess_existing');
  });
});

describe('send', () => {
  it('returns the full response (delegates to stream + collectStream)', async () => {
    mockCreate.mockResolvedValue({ id: 'sess_s' });
    mockSseStream.mockResolvedValue(
      mockSse([
        { type: 'agent.message', id: 'evt_1', content: [{ type: 'text', text: 'Done.' }] },
        { type: 'session.status_idle', id: 'evt_2', stop_reason: { type: 'end_turn' } },
      ]),
    );
    mockSend.mockResolvedValue({});

    const rt = createAnthropicProvider(config);
    const response = await rt.send({ message: { role: 'user', content: 'ping' } as never });
    expect(response.content).toBe('Done.');
  });
});

describe('error mapping', () => {
  it('emits an error stream part on session.error', async () => {
    mockCreate.mockResolvedValue({ id: 'sess_err' });
    mockSseStream.mockResolvedValue(
      mockSse([
        { type: 'session.error', id: 'evt_1', error: { message: 'Unauthorized', type: 'authentication_error' } },
      ]),
    );
    mockSend.mockResolvedValue({});

    const result = await createAnthropicProvider(config).stream({
      message: { role: 'user', content: 'x' } as never,
    });
    result.response.catch(() => {});

    const parts = [];
    for await (const p of result.stream) parts.push(p);

    const errPart = parts.find((p) => p.type === 'error');
    expect(errPart).toBeDefined();
    expect((errPart as any).error).toBeInstanceOf(ThalamusError);
  });
});
