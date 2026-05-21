import type {
  BetaManagedAgentsAgentCustomToolUseEvent,
  BetaManagedAgentsAgentMCPToolResultEvent,
  BetaManagedAgentsAgentMCPToolUseEvent,
  BetaManagedAgentsAgentMessageEvent,
  BetaManagedAgentsAgentToolResultEvent,
  BetaManagedAgentsAgentToolUseEvent,
  BetaManagedAgentsSessionErrorEvent,
  BetaManagedAgentsSessionStatusIdleEvent,
  BetaManagedAgentsSpanModelRequestEndEvent,
  BetaManagedAgentsStreamSessionEvents,
} from "@anthropic-ai/sdk/resources/beta/sessions";
import { ThalamusError } from "../errors";
import {
  type ActionRequired,
  ANTHROPIC,
  type Response,
  type StreamPart,
  type Usage,
} from "../types";

type StopReason = BetaManagedAgentsSessionStatusIdleEvent["stop_reason"];

export function mapStopReason(reason: StopReason): Response["finishReason"] {
  switch (reason.type) {
    case "end_turn":
      return "stop";
    case "requires_action":
      return "requires-action";
    case "retries_exhausted":
      return "error";
    default:
      return "other";
  }
}

export function mapSessionError(raw: unknown): ThalamusError {
  const obj = raw as { message?: string; type?: string } | null;
  const msg = obj?.message ?? String(raw);
  const isAuth = obj?.type === "authentication_error";
  return new ThalamusError(msg, { provider: ANTHROPIC, isRetryable: !isAuth });
}

export class ResponseAccumulator {
  content = "";
  finishReason: Response["finishReason"] = "stop";
  usage: Usage | undefined;
  actionsRequired: ActionRequired[] = [];
  done = false;

  toResponse(sessionId: string): Response {
    return {
      content: this.content,
      sessionId,
      finishReason: this.finishReason,
      usage: this.usage,
      actionsRequired:
        this.actionsRequired.length > 0 ? this.actionsRequired : undefined,
    };
  }
}

export function* mapEvent(
  event: BetaManagedAgentsStreamSessionEvents,
  acc: ResponseAccumulator,
): Generator<StreamPart> {
  switch (event.type) {
    case "agent.message": {
      const e = event as BetaManagedAgentsAgentMessageEvent;
      for (const block of e.content) {
        if (block.type === "text") {
          acc.content += block.text;
          yield { type: "text-delta", text: block.text };
        }
      }
      break;
    }

    case "agent.thinking": {
      yield { type: "thinking", text: "" };
      break;
    }

    case "agent.tool_use": {
      const e = event as BetaManagedAgentsAgentToolUseEvent;
      yield {
        type: "tool-use-start",
        toolName: e.name,
        toolUseId: e.id,
        source: { type: "builtin" },
      };
      yield {
        type: "tool-use-done",
        toolName: e.name,
        toolUseId: e.id,
        input: e.input,
        source: { type: "builtin" },
      };
      break;
    }
    case "agent.tool_result": {
      const e = event as BetaManagedAgentsAgentToolResultEvent;
      const output = e.content?.find((b) => b.type === "text");
      yield {
        type: "tool-use-result",
        toolUseId: e.tool_use_id,
        output: output?.type === "text" ? output.text : undefined,
        source: { type: "builtin" },
      };
      break;
    }
    case "agent.mcp_tool_use": {
      const e = event as BetaManagedAgentsAgentMCPToolUseEvent;
      yield {
        type: "tool-use-start",
        toolName: e.name,
        toolUseId: e.id,
        source: {
          type: "mcp",
          serverName: e.mcp_server_name ?? "",
        },
      };
      yield {
        type: "tool-use-done",
        toolName: e.name,
        toolUseId: e.id,
        input: e.input,
        source: {
          type: "mcp",
          serverName: e.mcp_server_name ?? "",
        },
      };
      break;
    }
    case "agent.mcp_tool_result": {
      const e = event as BetaManagedAgentsAgentMCPToolResultEvent;
      const output = e.content?.find((b) => b.type === "text");
      yield {
        type: "tool-use-result",
        toolUseId: e.mcp_tool_use_id,
        output: output?.type === "text" ? output.text : undefined,
        source: {
          type: "mcp",
          serverName: "",
        },
      };
      break;
    }
    case "agent.custom_tool_use": {
      const e = event as BetaManagedAgentsAgentCustomToolUseEvent;
      acc.actionsRequired.push({
        type: "tool-confirmation",
        toolUseId: e.id,
        toolName: e.name,
        input: e.input as Record<string, unknown>,
      });
      acc.finishReason = "requires-action";
      break;
    }

    case "session.status_running": {
      yield { type: "status-change", status: "running" };
      break;
    }
    case "session.status_rescheduled": {
      yield { type: "status-change", status: "retrying" };
      break;
    }
    case "session.status_idle": {
      const e = event as BetaManagedAgentsSessionStatusIdleEvent;
      yield { type: "status-change", status: "idle" };
      acc.finishReason = mapStopReason(e.stop_reason);
      acc.done = true;
      break;
    }
    case "session.status_terminated": {
      throw new ThalamusError("Session terminated", {
        provider: ANTHROPIC,
        isRetryable: false,
      });
    }

    case "session.error": {
      const e = event as BetaManagedAgentsSessionErrorEvent;
      throw mapSessionError(e.error);
    }

    case "span.model_request_end": {
      const e = event as BetaManagedAgentsSpanModelRequestEndEvent;
      if (e.model_usage) {
        acc.usage = {
          inputTokens: e.model_usage.input_tokens,
          outputTokens: e.model_usage.output_tokens,
          totalTokens: e.model_usage.input_tokens + e.model_usage.output_tokens,
        };
      }
      break;
    }

    default: {
      yield {
        type: "provider-event",
        provider: ANTHROPIC,
        event: event.type,
        data: event as unknown as Record<string, unknown>,
      };
      break;
    }
  }
}
