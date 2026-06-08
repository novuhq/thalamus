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

/** Normalized tool output; provider parsers map into this shape. */
export type ToolResultContent =
  | { type: "text"; text: string }
  | {
      type: "citation";
      url: string;
      title?: string;
      excerpts?: string[];
    }
  | { type: "json"; value: unknown }
  | {
      type: "media";
      mediaType: string;
      data: string;
      name?: string;
    }
  | {
      type: "unknown";
      providerType: string;
      data: Record<string, unknown>;
    };

export interface ToolResult {
  toolUseId: string;
  content: ToolResultContent[];
  isError?: boolean;
  approved?: boolean;
}

export interface RequestParams {
  /** Messages for this turn. May include system, user, and assistant messages. */
  messages: Message[];
  /** Opaque session identifier returned by a prior response. Absent means start a new session. */
  sessionId?: string;
  /** Vault IDs to bind to this request (credentials available to MCP servers). */
  vaultIds?: string[];
  /** Approval responses or tool outputs from a previous requires-action turn. */
  toolResults?: ToolResult[];
  /** Pass-through options forwarded directly to the underlying provider SDK call. */
  providerOptions?: Record<string, unknown>;
  /** When fired, the SDK closes the connection and the operation yields an `AbortedError`. */
  abortSignal?: AbortSignal;
  /** Metadata forwarded in the webhook payload for routing/context on the receiving end. */
  webhookMetadata?: Record<string, string>;
  /** Carry forward from a previous SendResult to group approval resumes into one logical turn. */
  turnId?: string;
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
      content: ToolResultContent[];
      isError?: boolean;
      source?: ToolSource;
    }
  | {
      type: "mcp-tools-discovered";
      serverName: string;
      tools: McpToolDef[];
    }
  | { type: "step-start"; stepIndex: number }
  | { type: "step-done"; stepIndex: number }
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

export interface StreamCallbacks {
  /** Fires for every stream part, before type-specific callbacks. */
  onPart?: (part: StreamPart) => void | Promise<void>;
  onTextDelta?: (
    part: Extract<StreamPart, { type: "text-delta" }>,
  ) => void | Promise<void>;
  onThinking?: (
    part: Extract<StreamPart, { type: "thinking" }>,
  ) => void | Promise<void>;
  onRefusal?: (
    part: Extract<StreamPart, { type: "refusal" }>,
  ) => void | Promise<void>;
  onToolUseStart?: (
    part: Extract<StreamPart, { type: "tool-use-start" }>,
  ) => void | Promise<void>;
  onToolUseDelta?: (
    part: Extract<StreamPart, { type: "tool-use-delta" }>,
  ) => void | Promise<void>;
  onToolUseDone?: (
    part: Extract<StreamPart, { type: "tool-use-done" }>,
  ) => void | Promise<void>;
  onToolUseResult?: (
    part: Extract<StreamPart, { type: "tool-use-result" }>,
  ) => void | Promise<void>;
  onMcpToolsDiscovered?: (
    part: Extract<StreamPart, { type: "mcp-tools-discovered" }>,
  ) => void | Promise<void>;
  onStepStart?: (
    part: Extract<StreamPart, { type: "step-start" }>,
  ) => void | Promise<void>;
  onStepDone?: (
    part: Extract<StreamPart, { type: "step-done" }>,
  ) => void | Promise<void>;
  onStatusChange?: (
    part: Extract<StreamPart, { type: "status-change" }>,
  ) => void | Promise<void>;
  onStreamStart?: (
    part: Extract<StreamPart, { type: "stream-start" }>,
  ) => void | Promise<void>;
  onFinish?: (
    part: Extract<StreamPart, { type: "finish" }>,
  ) => void | Promise<void>;
  onError?: (
    part: Extract<StreamPart, { type: "error" }>,
  ) => void | Promise<void>;
  onProviderEvent?: (
    part: Extract<StreamPart, { type: "provider-event" }>,
  ) => void | Promise<void>;
}

export interface SendResult extends PromiseLike<Response> {
  /** Unique identifier for this `send()` invocation. Known synchronously. */
  readonly runId: string;
  /** Stable turn identifier — carry this to subsequent send() calls for grouping. */
  readonly turnId: string;
  readonly sessionId: Promise<string>;
  readonly response: Promise<Response>;
  text(): Promise<string>;
}

export interface WebhookSendResult {
  sessionId: string;
  /** Unique identifier for this `send()` invocation, also present in every webhook event. */
  runId: string;
  /** Stable turn identifier — carry this to subsequent send() calls for grouping. */
  turnId: string;
  /** Whether this turn started immediately or was queued behind an in-flight session turn. */
  status: "active" | "queued";
}

export interface SessionEventContext {
  /** Provider session identity. */
  sessionId: string;
  /** Stable across approval resumes — groups sends within one user interaction. */
  turnId: string;
  /** Unique per send() invocation — identifies one webhook delivery / stream run. */
  runId: string;
  /** Webhook metadata from the originating send(). Empty object in streaming mode. */
  metadata: Record<string, string>;
}

export type SessionEventsFactory = (
  context: SessionEventContext,
) => StreamCallbacks;

interface BaseProvider {
  readonly provider: string;
  readonly runtimeId: string;
  createVault(options: VaultOptions): Promise<Vault>;
  getVault(vaultId: string): Promise<Vault>;
  createSession(options?: SessionOptions): Promise<string>;
  endSession(sessionId: string): Promise<void>;
}

import type { ThalamusLoggerInput } from "./logger";

export interface ProviderWebhookHandlerOptions {
  secret: string;
  onSessionEvents?: SessionEventsFactory;
  logger?: ThalamusLoggerInput;
}

export interface StreamingProvider extends BaseProvider {
  send(params: RequestParams): SendResult;
}

export interface WebhookProvider extends BaseProvider {
  send(params: RequestParams): Promise<WebhookSendResult>;
  createWebhookHandler(
    options: ProviderWebhookHandlerOptions,
  ): import("./webhook/index.js").WebhookHandler;
  /** Dispatch a previously queued message via SDK. Called by the webhook handler when a `queue-ready` event arrives. */
  dispatchQueued(
    sessionId: string,
    runId: string,
    turnId: string,
    request: import("./durable/types").SerializedRequestParams,
  ): Promise<void>;
}

export type Provider = StreamingProvider | WebhookProvider;

export const ANTHROPIC = "anthropic" as const;
export const OPENAI = "openai" as const;
