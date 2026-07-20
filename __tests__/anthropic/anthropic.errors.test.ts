import { APIError } from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicProvider } from "../../src/anthropic/anthropic.provider.js";
import { SessionExpiredError, ThalamusError } from "../../src/errors.js";
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

describe("error mapping", () => {
  it("emits an error stream part on session.error", async () => {
    mockCreate.mockResolvedValue({ id: "sess_err" });
    mockSseStream.mockResolvedValue(
      mockSse([
        {
          type: "session.error",
          id: "evt_1",
          error: { message: "Unauthorized", type: "authentication_error" },
        },
      ]),
    );
    mockSend.mockResolvedValue({});

    const parts: any[] = [];
    try {
      await createAnthropicProvider({
        ...config,
        onSessionEvents: () => ({ onPart: (p) => parts.push(p) }),
      }).send({ messages: [{ role: MessageRole.USER, content: "x" }] });
    } catch (_) {}

    const errPart = parts.find((p) => p.type === "error");
    expect(errPart).toBeDefined();
    expect((errPart as any).error).toBeInstanceOf(ThalamusError);
  });

  it("emits mcp-server-failure (authentication) on mcp_authentication_failed_error", async () => {
    mockCreate.mockResolvedValue({ id: "sess_mcp_auth" });
    mockSseStream.mockResolvedValue(
      mockSse([
        {
          type: "session.error",
          id: "evt_1",
          error: {
            type: "mcp_authentication_failed_error",
            mcp_server_name: "Stripe",
            message:
              "MCP server 'Stripe' authentication failed: credential has been invalidated — re-authentication is required.",
            retry_status: { type: "terminal" },
          },
        },
        {
          type: "session.status_idle",
          id: "evt_2",
          stop_reason: { type: "end_turn" },
        },
      ]),
    );
    mockSend.mockResolvedValue({});

    const parts: any[] = [];
    const mcpFailures: any[] = [];
    await createAnthropicProvider({
      ...config,
      onSessionEvents: () => ({
        onPart: (p) => parts.push(p),
        onMcpServerFailure: (p) => mcpFailures.push(p),
      }),
    }).send({ messages: [{ role: MessageRole.USER, content: "x" }] });

    expect(parts.find((p) => p.type === "error")).toBeUndefined();
    expect(mcpFailures).toHaveLength(1);
    expect(mcpFailures[0]).toMatchObject({
      type: "mcp-server-failure",
      reason: "authentication",
      serverName: "Stripe",
    });
  });

  it("emits mcp-server-failure (connection) without aborting the session", async () => {
    mockCreate.mockResolvedValue({ id: "sess_mcp_conn" });
    mockSseStream.mockResolvedValue(
      mockSse([
        {
          type: "session.error",
          id: "evt_1",
          error: {
            type: "mcp_connection_failed_error",
            mcp_server_name: "GitHub",
            message:
              "MCP server 'GitHub' initialize failed: connection refused",
            retry_status: { type: "terminal" },
          },
        },
        {
          type: "session.status_idle",
          id: "evt_2",
          stop_reason: { type: "end_turn" },
        },
      ]),
    );
    mockSend.mockResolvedValue({});

    const parts: any[] = [];
    const mcpFailures: any[] = [];
    const response = await createAnthropicProvider({
      ...config,
      onSessionEvents: () => ({
        onPart: (p) => parts.push(p),
        onMcpServerFailure: (p) => mcpFailures.push(p),
      }),
    }).send({ messages: [{ role: MessageRole.USER, content: "x" }] });

    expect(parts.find((p) => p.type === "error")).toBeUndefined();
    expect(mcpFailures).toHaveLength(1);
    expect(mcpFailures[0]).toMatchObject({
      type: "mcp-server-failure",
      reason: "connection",
      serverName: "GitHub",
    });
    expect(parts.some((p) => p.type === "finish")).toBe(true);
    expect(response.finishReason).toBe("stop");
  });
});

describe("session expiry detection", () => {
  it("throws SessionExpiredError when SSE stream returns 404 on resume", async () => {
    const notFoundError = new APIError(404, undefined, "Not Found", undefined);
    mockSseStream.mockRejectedValue(notFoundError);

    const parts: any[] = [];
    try {
      await createAnthropicProvider({
        ...config,
        onSessionEvents: () => ({ onPart: (p) => parts.push(p) }),
      }).send({
        messages: [{ role: MessageRole.USER, content: "hello" }],
        sessionId: "sess_expired",
      });
    } catch (_) {}

    const errPart = parts.find((p) => p.type === "error");
    expect(errPart).toBeDefined();
    expect((errPart as any).error).toBeInstanceOf(SessionExpiredError);
    expect((errPart as any).error.sessionId).toBe("sess_expired");
    expect((errPart as any).error.isRetryable).toBe(true);
  });

  it("throws SessionExpiredError when SSE stream returns 410 on resume", async () => {
    const goneError = new APIError(410, undefined, "Gone", undefined);
    mockSseStream.mockRejectedValue(goneError);

    const parts: any[] = [];
    try {
      await createAnthropicProvider({
        ...config,
        onSessionEvents: () => ({ onPart: (p) => parts.push(p) }),
      }).send({
        messages: [{ role: MessageRole.USER, content: "hello" }],
        sessionId: "sess_gone",
      });
    } catch (_) {}

    const errPart = parts.find((p) => p.type === "error");
    expect(errPart).toBeDefined();
    expect((errPart as any).error).toBeInstanceOf(SessionExpiredError);
    expect((errPart as any).error.sessionId).toBe("sess_gone");
  });

  it("does NOT throw SessionExpiredError for other errors", async () => {
    const serverError = new APIError(
      500,
      undefined,
      "Internal Server Error",
      undefined,
    );
    mockSseStream.mockRejectedValue(serverError);

    const parts: any[] = [];
    try {
      await createAnthropicProvider({
        ...config,
        onSessionEvents: () => ({ onPart: (p) => parts.push(p) }),
      }).send({
        messages: [{ role: MessageRole.USER, content: "hello" }],
        sessionId: "sess_other",
      });
    } catch (_) {}

    const errPart = parts.find((p) => p.type === "error");
    expect(errPart).toBeDefined();
    expect((errPart as any).error).not.toBeInstanceOf(SessionExpiredError);
  });

  it("does NOT throw SessionExpiredError for 404 on new session (no sessionId)", async () => {
    const notFoundError = Object.assign(new Error("Not Found"), {
      status: 404,
    });
    mockCreate.mockRejectedValue(notFoundError);

    const parts: any[] = [];
    try {
      await createAnthropicProvider({
        ...config,
        onSessionEvents: () => ({ onPart: (p) => parts.push(p) }),
      }).send({
        messages: [{ role: MessageRole.USER, content: "hello" }],
      });
    } catch (_) {}

    const errPart = parts.find((p) => p.type === "error");
    expect(errPart).toBeDefined();
    expect((errPart as any).error).not.toBeInstanceOf(SessionExpiredError);
  });
});
