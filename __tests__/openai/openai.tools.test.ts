import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAIProvider } from "../../src/openai/openai.provider.js";
import { collectStream } from "../../src/stream-utils.js";
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
  return { default: MockOpenAI, APIError: actual.APIError };
});

afterEach(() => vi.clearAllMocks());

describe("tool call streaming", () => {
  it("emits tool-use-start, tool-use-delta, tool-use-done in sequence", async () => {
    mockConversationsCreate.mockResolvedValue({ id: "conv_tool" });
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: { id: "resp_t", conversation: { id: "conv_tool" } },
        },
        {
          type: "response.output_item.added",
          item: {
            type: "function_call",
            name: "get_weather",
            call_id: "call_1",
          },
          output_index: 0,
          sequence_number: 1,
        },
        {
          type: "response.function_call_arguments.delta",
          delta: '{"lo',
          item_id: "call_1",
          output_index: 0,
          sequence_number: 2,
        },
        {
          type: "response.function_call_arguments.delta",
          delta: 'c":"NYC"}',
          item_id: "call_1",
          output_index: 0,
          sequence_number: 3,
        },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            name: "get_weather",
            call_id: "call_1",
            arguments: '{"loc":"NYC"}',
          },
          output_index: 0,
          sequence_number: 4,
        },
        {
          type: "response.completed",
          response: { id: "resp_t", output_text: "", usage: {} },
        },
      ]),
    );

    const result = await createOpenAIProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: "weather?" }],
    });
    const parts = [];
    for await (const p of result.stream) parts.push(p);

    const toolParts = parts.filter(
      (p) =>
        p.type === "tool-use-start" ||
        p.type === "tool-use-delta" ||
        p.type === "tool-use-done",
    );
    expect(toolParts).toEqual([
      {
        type: "tool-use-start",
        toolName: "get_weather",
        toolUseId: "call_1",
        source: { type: "builtin" },
      },
      { type: "tool-use-delta", toolUseId: "call_1", argumentsDelta: '{"lo' },
      {
        type: "tool-use-delta",
        toolUseId: "call_1",
        argumentsDelta: 'c":"NYC"}',
      },
      {
        type: "tool-use-done",
        toolName: "get_weather",
        toolUseId: "call_1",
        input: { loc: "NYC" },
        source: { type: "builtin" },
      },
    ]);
  });
});

describe("tool results / approval flow", () => {
  it("sends mcp_approval_response input when toolResults has approved=true", async () => {
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: {
            id: "resp_apr",
            conversation: { id: "conv_apr" },
            status: "in_progress",
          },
        },
        {
          type: "response.completed",
          response: {
            id: "resp_apr",
            output_text: "Done!",
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ]),
    );

    const provider = createOpenAIProvider(config);
    await collectStream(
      await provider.stream({
        messages: [{ role: MessageRole.USER, content: "" }],
        sessionId: "conv_prev",
        toolResults: [{ toolUseId: "appr_1", approved: true }],
      }),
    );

    const callArgs = mockResponsesCreate.mock.calls[0][0];
    const approvalInput = callArgs.input?.find(
      (i: any) => i.type === "mcp_approval_response",
    );
    expect(approvalInput).toMatchObject({
      type: "mcp_approval_response",
      approval_request_id: "appr_1",
      approve: true,
    });
  });

  it("sends function_call_output input when toolResults has output", async () => {
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: {
            id: "resp_fco",
            conversation: { id: "conv_fco" },
            status: "in_progress",
          },
        },
        {
          type: "response.completed",
          response: {
            id: "resp_fco",
            output_text: "Got it",
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ]),
    );

    const provider = createOpenAIProvider(config);
    await collectStream(
      await provider.stream({
        messages: [{ role: MessageRole.USER, content: "" }],
        sessionId: "conv_prev",
        toolResults: [{ toolUseId: "call_abc", output: '{"result": 42}' }],
      }),
    );

    const callArgs = mockResponsesCreate.mock.calls[0][0];
    const toolOutput = callArgs.input?.find(
      (i: any) => i.type === "function_call_output",
    );
    expect(toolOutput).toMatchObject({
      type: "function_call_output",
      call_id: "call_abc",
      output: '{"result": 42}',
    });
  });
});
