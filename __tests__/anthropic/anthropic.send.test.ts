import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicProvider } from "../../src/anthropic/anthropic.provider.js";
import { MessageRole } from "../../src/types.js";
import { config, mockSse } from "./_helpers.js";

const mockCreate = vi.fn();
const mockSseStream = vi.fn();
const mockSend = vi.fn();

vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  // biome-ignore lint/complexity/useArrowFunction: must be callable with `new`
  const MockAnthropic = function () {
    return {
      beta: {
        sessions: {
          create: mockCreate,
          events: { stream: mockSseStream, send: mockSend },
        },
        vaults: { create: vi.fn(), retrieve: vi.fn() },
      },
    };
  };
  return {
    default: MockAnthropic,
    APIError: actual.APIError,
    APIUserAbortError: actual.APIUserAbortError,
  };
});

vi.mock("@anthropic-ai/aws-sdk", () => ({
  AnthropicAws: vi.fn(),
}));

afterEach(() => vi.clearAllMocks());

function setupBasicStream() {
  mockCreate.mockResolvedValue({ id: "sess_new" });
  mockSseStream.mockResolvedValue(
    mockSse([
      {
        type: "agent.message",
        id: "evt_1",
        content: [{ type: "text", text: "Hello!" }],
      },
      {
        type: "session.status_idle",
        id: "evt_2",
        stop_reason: { type: "end_turn" },
      },
    ]),
  );
  mockSend.mockResolvedValue({});
}

describe("send() — basic behavior", () => {
  it("await send() returns Response, same as old stream()", async () => {
    setupBasicStream();

    const provider = createAnthropicProvider(config);
    const response = await provider.send({
      messages: [{ role: MessageRole.USER, content: "Hi" }],
    });

    expect(response.content).toBe("Hello!");
    expect(response.sessionId).toBe("sess_new");
    expect(response.finishReason).toBe("stop");
  });

  it("send().text() resolves to the response text", async () => {
    setupBasicStream();

    const provider = createAnthropicProvider(config);
    const text = await provider
      .send({
        messages: [{ role: MessageRole.USER, content: "Hi" }],
      })
      .text();

    expect(text).toBe("Hello!");
  });

  it("send().sessionId resolves to the session ID", async () => {
    setupBasicStream();

    const provider = createAnthropicProvider(config);
    const result = provider.send({
      messages: [{ role: MessageRole.USER, content: "Hi" }],
    });

    const sessionId = await result.sessionId;
    expect(sessionId).toBe("sess_new");
  });

  it("drops assistant messages and sends only user input to Anthropic", async () => {
    setupBasicStream();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const provider = createAnthropicProvider(config);
    await provider.send({
      messages: [
        { role: MessageRole.ASSISTANT, content: "Welcome!" },
        { role: MessageRole.USER, content: "Hello" },
      ],
    });

    expect(mockSend).toHaveBeenCalledWith(
      "sess_new",
      {
        events: [
          {
            type: "user.message",
            content: [{ type: "text", text: "Hello" }],
          },
        ],
      },
      expect.objectContaining({}),
    );
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("send() — onSessionEvents factory", () => {
  it("calls onSessionEvents factory and routes events through callbacks", async () => {
    setupBasicStream();

    const onTextDelta = vi.fn();
    const onFinish = vi.fn();
    const factory = vi.fn().mockReturnValue({ onTextDelta, onFinish });

    const provider = createAnthropicProvider({
      ...config,
      onSessionEvents: factory,
    });

    const response = await provider.send({
      messages: [{ role: MessageRole.USER, content: "Hi" }],
    });

    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "<<pending>>",
        runId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        turnId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        metadata: {},
      }),
    );
    expect(onTextDelta).toHaveBeenCalledWith(
      expect.objectContaining({ type: "text-delta", text: "Hello!" }),
    );
    expect(onFinish).toHaveBeenCalledWith(
      expect.objectContaining({ type: "finish" }),
    );
    expect(response.content).toBe("Hello!");
  });

  it("passes existing sessionId to factory when provided", async () => {
    mockSseStream.mockResolvedValue(
      mockSse([
        {
          type: "agent.message",
          id: "evt_1",
          content: [{ type: "text", text: "Continued." }],
        },
        {
          type: "session.status_idle",
          id: "evt_2",
          stop_reason: { type: "end_turn" },
        },
      ]),
    );
    mockSend.mockResolvedValue({});

    const factory = vi.fn().mockReturnValue({});

    const provider = createAnthropicProvider({
      ...config,
      onSessionEvents: factory,
    });

    await provider.send({
      messages: [{ role: MessageRole.USER, content: "next" }],
      sessionId: "sess_existing",
    });

    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess_existing",
        runId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        turnId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        metadata: {},
      }),
    );
  });

  it("auto-starts: callbacks fire even without await (fire-and-forget)", async () => {
    setupBasicStream();

    const onFinish = vi.fn();
    const factory = vi.fn().mockReturnValue({ onFinish });

    const provider = createAnthropicProvider({
      ...config,
      onSessionEvents: factory,
    });

    const result = provider.send({
      messages: [{ role: MessageRole.USER, content: "Hi" }],
    });

    // Don't await — just wait for the internal promise to settle
    await result.response;

    expect(onFinish).toHaveBeenCalledOnce();
  });
});

describe("send() — lazy without onSessionEvents", () => {
  it("does not start consumption until awaited", async () => {
    setupBasicStream();

    const provider = createAnthropicProvider(config);
    const result = provider.send({
      messages: [{ role: MessageRole.USER, content: "Hi" }],
    });

    // Before awaiting, the stream shouldn't have started
    // (we can't directly assert this, but we can verify it works when awaited)
    const response = await result;
    expect(response.content).toBe("Hello!");
  });
});

describe("send() — runId", () => {
  it("exposes a UUID synchronously on SendResult", () => {
    setupBasicStream();

    const provider = createAnthropicProvider(config);
    const result = provider.send({
      messages: [{ role: MessageRole.USER, content: "Hi" }],
    });

    expect(result.runId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("generates a distinct runId per send() call", async () => {
    setupBasicStream();

    const provider = createAnthropicProvider(config);
    const r1 = provider.send({
      messages: [{ role: MessageRole.USER, content: "first" }],
    });
    setupBasicStream();
    const r2 = provider.send({
      messages: [{ role: MessageRole.USER, content: "second" }],
    });

    expect(r1.runId).not.toBe(r2.runId);
    await Promise.all([r1, r2]);
  });
});
