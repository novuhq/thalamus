import { APIUserAbortError } from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AbortedError } from "../../src/errors.js";
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

describe("send — abort signal", () => {
  it("yields AbortedError when the signal is aborted during streaming", async () => {
    mockConversationsCreate.mockResolvedValue({ id: "conv_abort" });
    mockResponsesCreate.mockRejectedValue(new APIUserAbortError());

    const controller = new AbortController();
    controller.abort();

    const result = createOpenAIProvider(config).send({
      messages: [{ role: MessageRole.USER, content: "Hi" }],
      abortSignal: controller.signal,
    });

    await expect(result).rejects.toThrow(AbortedError);
    await expect(result).rejects.toMatchObject({
      name: "AbortedError",
      isRetryable: false,
      provider: "openai",
    });
  });

  it("passes abort signal to responses.create as RequestOptions", async () => {
    mockConversationsCreate.mockResolvedValue({ id: "conv_sig" });
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: { id: "resp_1", conversation: { id: "conv_sig" } },
        },
        {
          type: "response.completed",
          response: { id: "resp_1", output_text: "ok", usage: {} },
        },
      ]),
    );

    const controller = new AbortController();
    await createOpenAIProvider(config).send({
      messages: [{ role: MessageRole.USER, content: "Hi" }],
      abortSignal: controller.signal,
    });

    expect(mockResponsesCreate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
