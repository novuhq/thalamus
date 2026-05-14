import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderAuthError } from "../../src/errors.js";
import { createOpenAIProvider } from "../../src/openai/openai.provider.js";
import { MessageRole } from "../../src/types.js";
import { config, makeStream } from "./_helpers.js";

const mockResponsesCreate = vi.fn();
const mockConversationsCreate = vi.fn();

vi.mock("openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openai")>();
  // biome-ignore lint/complexity/useArrowFunction: must be callable with `new`
  const MockOpenAI = function () {
    return {
      responses: { create: mockResponsesCreate },
      conversations: { create: mockConversationsCreate },
    };
  };
  return {
    default: MockOpenAI,
    APIError: actual.APIError,
    APIUserAbortError: actual.APIUserAbortError,
  };
});

afterEach(() => vi.clearAllMocks());

describe("refusal handling", () => {
  it("emits refusal parts and sets finishReason to refused", async () => {
    mockConversationsCreate.mockResolvedValue({ id: "conv_ref" });
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: { id: "resp_r", conversation: { id: "conv_ref" } },
        },
        {
          type: "response.refusal.delta",
          delta: "I cannot",
          item_id: "item_1",
          content_index: 0,
          output_index: 0,
          sequence_number: 1,
        },
        {
          type: "response.refusal.delta",
          delta: " help with that.",
          item_id: "item_1",
          content_index: 0,
          output_index: 0,
          sequence_number: 2,
        },
        {
          type: "response.completed",
          response: { id: "resp_r", output_text: "", usage: {} },
        },
      ]),
    );

    const parts: any[] = [];
    const response = await createOpenAIProvider({
      ...config,
      onSessionEvents: () => ({ onPart: (p) => parts.push(p) }),
    }).send({
      messages: [{ role: MessageRole.USER, content: "do something bad" }],
    });

    expect(parts.filter((p) => p.type === "refusal")).toEqual([
      { type: "refusal", text: "I cannot" },
      { type: "refusal", text: " help with that." },
    ]);

    expect(response.finishReason).toBe("refused");
  });
});

describe("error handling", () => {
  it("maps invalid_api_key to ProviderAuthError", async () => {
    mockConversationsCreate.mockResolvedValue({ id: "conv_err" });
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "error",
          message: "Incorrect API key",
          code: "invalid_api_key",
        },
      ]),
    );

    const parts: any[] = [];
    const promise = createOpenAIProvider({
      ...config,
      onSessionEvents: () => ({ onPart: (p) => parts.push(p) }),
    }).send({ messages: [{ role: MessageRole.USER, content: "x" }] });
    await expect(promise).rejects.toBeInstanceOf(ProviderAuthError);
    expect(
      (parts.find((p) => p.type === "error") as any)?.error,
    ).toBeInstanceOf(ProviderAuthError);
  });

  it("maps rate_limit_exceeded to ProviderRateLimitError", async () => {
    mockConversationsCreate.mockResolvedValue({ id: "conv_rl" });
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "error",
          message: "Rate limit exceeded",
          code: "rate_limit_exceeded",
        },
      ]),
    );

    const parts: any[] = [];
    try {
      await createOpenAIProvider({
        ...config,
        onSessionEvents: () => ({ onPart: (p) => parts.push(p) }),
      }).send({ messages: [{ role: MessageRole.USER, content: "x" }] });
    } catch (_) {}

    const { ProviderRateLimitError } = await import("../../src/errors.js");
    expect(
      (parts.find((p) => p.type === "error") as any)?.error,
    ).toBeInstanceOf(ProviderRateLimitError);
  });

  it("maps thrown unavailable error to ProviderUnavailableError", async () => {
    mockConversationsCreate.mockResolvedValue({ id: "conv_503" });
    mockResponsesCreate.mockImplementation(() => {
      throw new Error("Service unavailable");
    });

    const parts: any[] = [];
    try {
      await createOpenAIProvider({
        ...config,
        onSessionEvents: () => ({ onPart: (p) => parts.push(p) }),
      }).send({ messages: [{ role: MessageRole.USER, content: "x" }] });
    } catch (_) {}

    const { ProviderUnavailableError } = await import("../../src/errors.js");
    expect(
      (parts.find((p) => p.type === "error") as any)?.error,
    ).toBeInstanceOf(ProviderUnavailableError);
  });
});
