import { b as VaultOptions, V as Vault } from './vault.interface-BMCawAU1.cjs';

declare enum MessageRole {
    USER = "user",
    ASSISTANT = "assistant",
    SYSTEM = "system"
}
type ContentPart = {
    type: "text";
    text: string;
} | {
    type: "image";
    data: string;
    mediaType: string;
} | {
    type: "image-url";
    url: string;
} | {
    type: "file";
    data: string;
    mediaType: string;
    name?: string;
};
interface Message {
    role: MessageRole;
    content: string | ContentPart[];
}
interface ToolResult {
    toolUseId: string;
    output?: string;
    isError?: boolean;
    approved?: boolean;
}
interface RequestParams {
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
}
interface SessionOptions {
    vaultIds?: string[];
    providerOptions?: Record<string, unknown>;
}
interface Usage {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
}
type ToolSource = {
    type: "builtin";
} | {
    type: "custom";
} | {
    type: "mcp";
    serverName: string;
};
type McpApprovalPolicy = "always" | "never" | {
    except: string[];
};
interface McpServerConfig {
    name: string;
    url: string;
    authorization?: string;
    allowedTools?: string[];
    approvalPolicy?: McpApprovalPolicy;
}
interface McpToolDef {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
}
type ActionRequired = {
    type: "tool-confirmation";
    toolUseId: string;
    toolName: string;
    input?: Record<string, unknown>;
} | {
    type: "mcp-approval";
    toolUseId: string;
    toolName: string;
    serverName: string;
    input?: Record<string, unknown>;
};
interface Response {
    content: string;
    /** Session identifier to pass as `sessionId` on the next turn to continue the conversation. */
    sessionId?: string;
    finishReason: "stop" | "length" | "error" | "requires-action" | "refused" | "other";
    usage?: Usage;
    actionsRequired?: ActionRequired[];
}
type AgentStatus = "running" | "queued" | "retrying" | "idle";
type StreamPart = {
    type: "text-delta";
    text: string;
} | {
    type: "refusal";
    text: string;
} | {
    type: "thinking";
    text: string;
} | {
    type: "tool-use-start";
    toolName: string;
    toolUseId: string;
    source?: ToolSource;
} | {
    type: "tool-use-delta";
    toolUseId: string;
    argumentsDelta: string;
} | {
    type: "tool-use-done";
    toolName: string;
    toolUseId: string;
    input?: Record<string, unknown>;
    source?: ToolSource;
} | {
    type: "tool-use-result";
    toolUseId: string;
    output?: string;
    source?: ToolSource;
} | {
    type: "mcp-tools-discovered";
    serverName: string;
    tools: McpToolDef[];
} | {
    type: "status-change";
    status: AgentStatus;
} | {
    type: "stream-start";
    sessionId?: string;
} | {
    type: "finish";
    response: Response;
} | {
    type: "error";
    error: Error;
} | {
    type: "provider-event";
    provider: string;
    event: string;
    data: Record<string, unknown>;
};
interface StreamCallbacks {
    /** Fires for every stream part, before type-specific callbacks. */
    onPart?: (part: StreamPart) => void;
    onTextDelta?: (part: Extract<StreamPart, {
        type: "text-delta";
    }>) => void;
    onThinking?: (part: Extract<StreamPart, {
        type: "thinking";
    }>) => void;
    onRefusal?: (part: Extract<StreamPart, {
        type: "refusal";
    }>) => void;
    onToolUseStart?: (part: Extract<StreamPart, {
        type: "tool-use-start";
    }>) => void;
    onToolUseDelta?: (part: Extract<StreamPart, {
        type: "tool-use-delta";
    }>) => void;
    onToolUseDone?: (part: Extract<StreamPart, {
        type: "tool-use-done";
    }>) => void;
    onToolUseResult?: (part: Extract<StreamPart, {
        type: "tool-use-result";
    }>) => void;
    onMcpToolsDiscovered?: (part: Extract<StreamPart, {
        type: "mcp-tools-discovered";
    }>) => void;
    onStatusChange?: (part: Extract<StreamPart, {
        type: "status-change";
    }>) => void;
    onStreamStart?: (part: Extract<StreamPart, {
        type: "stream-start";
    }>) => void;
    onFinish?: (part: Extract<StreamPart, {
        type: "finish";
    }>) => void;
    onError?: (part: Extract<StreamPart, {
        type: "error";
    }>) => void;
    onProviderEvent?: (part: Extract<StreamPart, {
        type: "provider-event";
    }>) => void;
}
interface SendResult extends PromiseLike<Response> {
    readonly sessionId: Promise<string>;
    readonly response: Promise<Response>;
    text(): Promise<string>;
}
type SessionEventsFactory = (sessionId: string) => StreamCallbacks;
interface Provider {
    readonly provider: string;
    readonly runtimeId: string;
    send(params: RequestParams): SendResult;
    createVault(options: VaultOptions): Promise<Vault>;
    getVault(vaultId: string): Promise<Vault>;
    createSession(options?: SessionOptions): Promise<string>;
    endSession(sessionId: string): Promise<void>;
}
declare const ANTHROPIC: "anthropic";
declare const OPENAI: "openai";

export { ANTHROPIC as A, type ContentPart as C, type McpApprovalPolicy as M, OPENAI as O, type Provider as P, type RequestParams as R, type StreamPart as S, type ToolResult as T, type Usage as U, type StreamCallbacks as a, type SendResult as b, type ActionRequired as c, type AgentStatus as d, type McpServerConfig as e, type McpToolDef as f, type Message as g, MessageRole as h, type Response as i, type SessionEventsFactory as j, type SessionOptions as k, type ToolSource as l };
