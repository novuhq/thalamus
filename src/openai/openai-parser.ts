import { APIError, APIUserAbortError } from "openai";
import type {
  ResponseErrorEvent,
  ResponseMcpCallArgumentsDeltaEvent,
  ResponseOutputItem,
  ResponseOutputItemAddedEvent,
  ResponseOutputItemDoneEvent,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import {
  AbortedError,
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderResponseError,
  ProviderUnavailableError,
  ThalamusError,
} from "../errors";
import {
  type ActionRequired,
  OPENAI,
  type Response,
  type StreamPart,
  type Usage,
} from "../types";

function isResponseErrorEvent(e: unknown): e is ResponseErrorEvent {
  return (
    typeof e === "object" &&
    e !== null &&
    "type" in e &&
    (e as ResponseErrorEvent).type === "error" &&
    "code" in e
  );
}

export function mapError(error: unknown, provider: string): Error {
  if (error instanceof APIUserAbortError) {
    return new AbortedError({ provider, cause: error });
  }

  const msg = error instanceof Error ? error.message : String(error);
  const code =
    error instanceof APIError
      ? (error.code ?? "")
      : isResponseErrorEvent(error)
        ? (error.code ?? "")
        : "";
  if (
    code === "invalid_api_key" ||
    msg.toLowerCase().includes("unauthorized")
  ) {
    return new ProviderAuthError(msg, { provider, cause: error });
  }
  if (
    code === "rate_limit_exceeded" ||
    msg.toLowerCase().includes("rate limit")
  ) {
    return new ProviderRateLimitError(msg, { provider, cause: error });
  }
  if (
    msg.toLowerCase().includes("unavailable") ||
    msg.toLowerCase().includes("503")
  ) {
    return new ProviderUnavailableError(msg, { provider, cause: error });
  }
  return new ProviderResponseError(msg, { provider, cause: error });
}

export class ResponseAccumulator {
  content = "";
  sessionId: string | undefined;
  conversationId: string | undefined;
  finishReason: Response["finishReason"] = "stop";
  usage: Usage | undefined;
  actionsRequired: ActionRequired[] = [];

  toResponse(): Response {
    return {
      content: this.content,
      sessionId: this.conversationId ?? this.sessionId,
      finishReason: this.finishReason,
      usage: this.usage,
      actionsRequired:
        this.actionsRequired.length > 0 ? this.actionsRequired : undefined,
    };
  }
}

export function* mapEvent(
  event: ResponseStreamEvent,
  acc: ResponseAccumulator,
): Generator<StreamPart> {
  switch (event.type) {
    case "response.created": {
      acc.sessionId = event.response.id;
      acc.conversationId = event.response.conversation?.id;
      yield {
        type: "stream-start",
        sessionId: acc.conversationId ?? acc.sessionId,
      };
      break;
    }
    case "response.in_progress": {
      yield { type: "status-change", status: "running" };
      break;
    }
    case "response.completed": {
      if (event.response.usage) {
        acc.usage = {
          inputTokens: event.response.usage.input_tokens,
          outputTokens: event.response.usage.output_tokens,
          totalTokens: event.response.usage.total_tokens,
        };
      }
      if (!acc.content) {
        acc.content = event.response.output_text;
      }
      break;
    }
    case "response.failed": {
      acc.finishReason = "error";
      throw new ThalamusError(
        event.response.error?.message ?? "Response failed",
        { provider: OPENAI, isRetryable: false },
      );
    }
    case "response.incomplete": {
      acc.finishReason = "length";
      break;
    }

    case "response.output_text.delta": {
      acc.content += event.delta;
      yield { type: "text-delta", text: event.delta };
      break;
    }

    case "response.refusal.delta": {
      acc.finishReason = "refused";
      yield { type: "refusal", text: event.delta };
      break;
    }

    case "response.reasoning_summary_text.delta": {
      yield { type: "thinking", text: event.delta };
      break;
    }

    case "response.output_item.added": {
      const e = event as ResponseOutputItemAddedEvent;
      if (e.item.type === "function_call") {
        yield {
          type: "tool-use-start",
          toolName: e.item.name,
          toolUseId: e.item.call_id,
          source: { type: "builtin" },
        };
      } else if (e.item.type === "mcp_call") {
        const item = e.item as ResponseOutputItem.McpCall;
        yield {
          type: "tool-use-start",
          toolName: item.name,
          toolUseId: item.id,
          source: { type: "mcp", serverName: item.server_label },
        };
      }
      break;
    }
    case "response.function_call_arguments.delta": {
      yield {
        type: "tool-use-delta",
        toolUseId: event.item_id,
        argumentsDelta: event.delta,
      };
      break;
    }
    case "response.mcp_call_arguments.delta": {
      const e = event as ResponseMcpCallArgumentsDeltaEvent;
      yield {
        type: "tool-use-delta",
        toolUseId: e.item_id,
        argumentsDelta: e.delta,
      };
      break;
    }
    case "response.output_item.done": {
      const e = event as ResponseOutputItemDoneEvent;
      if (e.item.type === "function_call") {
        yield {
          type: "tool-use-done",
          toolName: e.item.name,
          toolUseId: e.item.call_id,
          input: JSON.parse(e.item.arguments || "{}"),
          source: { type: "builtin" },
        };
      } else if (e.item.type === "mcp_list_tools") {
        const item = e.item as ResponseOutputItem.McpListTools;
        yield {
          type: "mcp-tools-discovered",
          serverName: item.server_label,
          tools: (item.tools ?? []).map((t) => ({
            name: t.name,
            description: t.description ?? undefined,
            inputSchema: t.input_schema as Record<string, unknown> | undefined,
          })),
        };
      } else if (e.item.type === "mcp_call") {
        const item = e.item as ResponseOutputItem.McpCall;
        yield {
          type: "tool-use-done",
          toolName: item.name,
          toolUseId: item.id,
          input: JSON.parse(item.arguments || "{}"),
          source: { type: "mcp", serverName: item.server_label },
        };
        yield {
          type: "tool-use-result",
          toolUseId: item.id,
          output: item.output ?? undefined,
          source: { type: "mcp", serverName: item.server_label },
        };
      } else if (e.item.type === "mcp_approval_request") {
        const item = e.item as ResponseOutputItem.McpApprovalRequest;
        acc.finishReason = "requires-action";
        acc.actionsRequired.push({
          type: "mcp-approval",
          toolUseId: item.id,
          toolName: item.name,
          serverName: item.server_label,
          input: JSON.parse(item.arguments || "{}"),
        });
      }
      break;
    }

    case "error": {
      throw mapError(event, OPENAI);
    }

    default: {
      yield {
        type: "provider-event",
        provider: OPENAI,
        event: event.type,
        data: event as unknown as Record<string, unknown>,
      };
      break;
    }
  }
}
