import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnthropicProvider } from '../../src/anthropic/anthropic.provider.js';
import { ThalamusError, SessionExpiredError } from '../../src/errors.js';
import { collectStream } from '../../src/stream-utils.js';
import { MessageRole } from '../../src/types.js';

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
const mockAnthropicAws = vi.hoisted(() => vi.fn());

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

vi.mock('@anthropic-ai/aws-sdk', () => ({
  AnthropicAws: mockAnthropicAws,
}));

mockAnthropicAws.mockImplementation(function (this: any, config: Record<string, unknown>) {
  return {
    beta: {
      sessions: {
        create: mockCreate,
        events: { stream: mockSseStream, send: mockSend },
      },
    },
    _awsConfig: config,
  };
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
      messages: [{ role: MessageRole.USER, content: 'Hi' }],
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
        messages: [{ role: MessageRole.USER, content: 'next' }],
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
    const response = await rt.send({ messages: [{ role: MessageRole.USER, content: 'ping' }] });
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
      messages: [{ role: MessageRole.USER, content: 'x' }],
    });
    result.response.catch(() => {});

    const parts = [];
    for await (const p of result.stream) parts.push(p);

    const errPart = parts.find((p) => p.type === 'error');
    expect(errPart).toBeDefined();
    expect((errPart as any).error).toBeInstanceOf(ThalamusError);
  });
});

const awsConfig = { agentId: 'agent_abc', environmentId: 'env_xyz', awsRegion: 'us-east-1' };

describe('AWS auth variant', () => {
  it('creates provider with awsRegion config', () => {
    const rt = createAnthropicProvider(awsConfig);
    expect(rt.provider).toBe('anthropic');
    expect(rt.runtimeId).toBe('agent_abc');
  });

  it('streams successfully via AnthropicAws client', async () => {
    mockCreate.mockResolvedValue({ id: 'sess_aws' });
    mockSseStream.mockResolvedValue(
      mockSse([
        { type: 'agent.message', id: 'evt_1', content: [{ type: 'text', text: 'Hello from AWS!' }] },
        { type: 'session.status_idle', id: 'evt_2', stop_reason: { type: 'end_turn' } },
      ]),
    );
    mockSend.mockResolvedValue({});

    const rt = createAnthropicProvider(awsConfig);
    const result = await rt.stream({
      messages: [{ role: MessageRole.USER, content: 'Hi' }],
    });

    const parts = [];
    for await (const part of result.stream) parts.push(part);

    expect(parts.find((p) => p.type === 'text-delta')).toMatchObject({ text: 'Hello from AWS!' });
    const response = await result.response;
    expect(response.content).toBe('Hello from AWS!');
    expect(response.sessionId).toBe('sess_aws');
  });

  it('passes awsWorkspaceId when provided', async () => {
    mockCreate.mockResolvedValue({ id: 'sess_ws' });
    mockSseStream.mockResolvedValue(
      mockSse([
        { type: 'session.status_idle', id: 'evt_1', stop_reason: { type: 'end_turn' } },
      ]),
    );
    mockSend.mockResolvedValue({});

    const rt = createAnthropicProvider({
      ...awsConfig,
      awsWorkspaceId: 'wrkspc_abc',
    });
    await rt.send({ messages: [{ role: MessageRole.USER, content: 'hi' }] });

    expect(mockAnthropicAws).toHaveBeenCalledWith({ awsRegion: 'us-east-1', workspaceId: 'wrkspc_abc' });
  });
});

describe('session expiry detection', () => {
  it('throws SessionExpiredError when SSE stream returns 404 on resume', async () => {
    const notFoundError = Object.assign(new Error('Not Found'), { status: 404 });
    mockSseStream.mockRejectedValue(notFoundError);

    const result = await createAnthropicProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: 'hello' }],
      sessionId: 'sess_expired',
    });
    result.response.catch(() => {});

    const parts = [];
    for await (const p of result.stream) parts.push(p);

    const errPart = parts.find((p) => p.type === 'error');
    expect(errPart).toBeDefined();
    expect((errPart as any).error).toBeInstanceOf(SessionExpiredError);
    expect((errPart as any).error.sessionId).toBe('sess_expired');
    expect((errPart as any).error.isRetryable).toBe(true);
  });

  it('throws SessionExpiredError when SSE stream returns 410 on resume', async () => {
    const goneError = Object.assign(new Error('Gone'), { status: 410 });
    mockSseStream.mockRejectedValue(goneError);

    const result = await createAnthropicProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: 'hello' }],
      sessionId: 'sess_gone',
    });
    result.response.catch(() => {});

    const parts = [];
    for await (const p of result.stream) parts.push(p);

    const errPart = parts.find((p) => p.type === 'error');
    expect(errPart).toBeDefined();
    expect((errPart as any).error).toBeInstanceOf(SessionExpiredError);
    expect((errPart as any).error.sessionId).toBe('sess_gone');
  });

  it('does NOT throw SessionExpiredError for other errors', async () => {
    const serverError = Object.assign(new Error('Internal Server Error'), { status: 500 });
    mockSseStream.mockRejectedValue(serverError);

    const result = await createAnthropicProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: 'hello' }],
      sessionId: 'sess_other',
    });
    result.response.catch(() => {});

    const parts = [];
    for await (const p of result.stream) parts.push(p);

    const errPart = parts.find((p) => p.type === 'error');
    expect(errPart).toBeDefined();
    expect((errPart as any).error).not.toBeInstanceOf(SessionExpiredError);
  });

  it('does NOT throw SessionExpiredError for 404 on new session (no sessionId)', async () => {
    const notFoundError = Object.assign(new Error('Not Found'), { status: 404 });
    mockCreate.mockRejectedValue(notFoundError);

    const result = await createAnthropicProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: 'hello' }],
    });
    result.response.catch(() => {});

    const parts = [];
    for await (const p of result.stream) parts.push(p);

    const errPart = parts.find((p) => p.type === 'error');
    expect(errPart).toBeDefined();
    expect((errPart as any).error).not.toBeInstanceOf(SessionExpiredError);
  });
});
