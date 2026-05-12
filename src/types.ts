import type { Vault, VaultOptions } from "./vault/vault.interface";

export enum MessageRole {
  USER = "user",
  ASSISTANT = "assistant",
  SYSTEM = "system",
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mediaType: string }
  | { type: "image-url"; url: string }
  | { type: "file"; data: string; mediaType: string; name?: string };

export interface Message {
  role: MessageRole;
  content: string | ContentPart[];
}

export interface RequestParams {
  /** Messages for this turn. May include system, user, and assistant messages. */
  messages: Message[];
  /** Opaque session identifier returned by a prior response. Absent means start a new session. */
  sessionId?: string;
  /** Vault IDs to bind to this request (credentials available to MCP servers). */
  vaultIds?: string[];
  /** Pass-through options forwarded directly to the underlying provider SDK call. */
  providerOptions?: Record<string, unknown>;
}

export interface SessionOptions {
  vaultIds?: string[];
  providerOptions?: Record<string, unknown>;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export type ToolSource =
  | { type: "builtin" }
  | { type: "custom" }
  | { type: "mcp"; serverName: string };

export type McpApprovalPolicy = "always" | "never" | { except: string[] };

export interface McpServerConfig {
  name: string;
  url: string;
  authorization?: string;
  allowedTools?: string[];
  approvalPolicy?: McpApprovalPolicy;
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export type ActionRequired =
  | {
      type: "tool-confirmation";
      toolUseId: string;
      toolName: string;
      input?: Record<string, unknown>;
    }
  | {
      type: "mcp-approval";
      toolUseId: string;
      toolName: string;
      serverName: string;
      input?: Record<string, unknown>;
    };

export interface Response {
  content: string;
  /** Session identifier to pass as `sessionId` on the next turn to continue the conversation. */
  sessionId?: string;
  finishReason:
    | "stop"
    | "length"
    | "error"
    | "requires-action"
    | "refused"
    | "other";
  usage?: Usage;
  actionsRequired?: ActionRequired[];
}

export type AgentStatus = "running" | "queued" | "retrying" | "idle";

export type StreamPart =
  | { type: "text-delta"; text: string }
  | { type: "refusal"; text: string }
  | { type: "thinking"; text: string }
  | {
      type: "tool-use-start";
      toolName: string;
      toolUseId: string;
      source?: ToolSource;
    }
  | { type: "tool-use-delta"; toolUseId: string; argumentsDelta: string }
  | {
      type: "tool-use-done";
      toolName: string;
      toolUseId: string;
      input?: Record<string, unknown>;
      source?: ToolSource;
    }
  | {
      type: "tool-use-result";
      toolUseId: string;
      output?: string;
      source?: ToolSource;
    }
  | {
      type: "mcp-tools-discovered";
      serverName: string;
      tools: McpToolDef[];
    }
  | { type: "status-change"; status: AgentStatus }
  | { type: "stream-start"; sessionId?: string }
  | { type: "finish"; response: Response }
  | { type: "error"; error: Error }
  | {
      type: "provider-event";
      provider: string;
      event: string;
      data: Record<string, unknown>;
    };

/**
 * Returned by `stream()`. Callers can iterate `stream` for incremental parts
 * and await `response` for the final rolled-up result. Both resolve from the
 * same underlying generator — consuming either one drives the other.
 */
export interface StreamResult {
  stream: AsyncIterable<StreamPart>;
  response: Promise<Response>;
}

export interface Provider {
  readonly provider: string;
  readonly runtimeId: string;
  send(params: RequestParams): Promise<Response>;
  stream(params: RequestParams): Promise<StreamResult>;
  createVault(options: VaultOptions): Promise<Vault>;
  getVault(vaultId: string): Promise<Vault>;
  createSession(options?: SessionOptions): Promise<string>;
  endSession(sessionId: string): Promise<void>;
}

export const ANTHROPIC = "anthropic" as const;
export const OPENAI = "openai" as const;
