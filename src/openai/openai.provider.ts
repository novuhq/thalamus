import OpenAI, { APIError } from "openai";
import type {
  ResponseCreateParamsStreaming,
  ResponseErrorEvent,
  ResponseInput,
  ResponseMcpCallArgumentsDeltaEvent,
  ResponseOutputItem,
  ResponseOutputItemAddedEvent,
  ResponseOutputItemDoneEvent,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import {
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderResponseError,
  ProviderUnavailableError,
  ThalamusError,
} from "../errors";
import { collectStream } from "../stream-utils";
import {
  type ActionRequired,
  type McpServerConfig,
  OPENAI,
  type Provider,
  type RequestParams,
  type Response,
  type SessionOptions,
  type StreamPart,
  type StreamResult,
  type Usage,
} from "../types";
import { LocalVault } from "../vault/local-vault";
import type {
  Credential,
  Vault,
  VaultOptions,
  VaultStore,
} from "../vault/vault.interface";
import { openaiTransformer } from "./openai.transformer";
import { createSigV4Fetch } from "./sigv4-fetch";

function isResponseErrorEvent(e: unknown): e is ResponseErrorEvent {
  return (
    typeof e === "object" &&
    e !== null &&
    "type" in e &&
    (e as ResponseErrorEvent).type === "error" &&
    "code" in e
  );
}

function mapError(error: unknown, provider: string): Error {
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

type OpenAIDirectConfig = {
  apiKey: string;
  awsRegion?: never;
  awsBedrockApiKey?: never;
  awsCredentials?: never;
};

type OpenAIBedrockApiKeyConfig = {
  awsRegion: string;
  awsBedrockApiKey: string;
  apiKey?: never;
  awsCredentials?: never;
};

type OpenAIBedrockSigV4Config = {
  awsRegion: string;
  awsCredentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  apiKey?: never;
  awsBedrockApiKey?: never;
};

type OpenAIBaseConfig = {
  model?: string;
  promptId?: string;
  instructions?: string;
  mcpServers?: McpServerConfig[];
  vaultStore?: VaultStore;
};

function mapApprovalPolicy(policy: McpServerConfig["approvalPolicy"]): unknown {
  if (!policy || typeof policy === "string") return policy;
  return { never: { tool_names: policy.except } };
}

// OpenAI SDK (v6.37) doesn't export MCP tool types yet — using untyped records
// matching the wire format from https://developers.openai.com/docs/guides/tools-connectors-mcp
function toMcpTools(
  servers: McpServerConfig[],
  credentials?: Map<string, Credential>,
): Record<string, unknown>[] {
  return servers.map((server) => {
    const tool: Record<string, unknown> = {
      type: "mcp",
      server_label: server.name,
      server_url: server.url,
    };

    // Vault credential takes priority over static server.authorization
    const cred = credentials?.get(server.name);
    if (cred) {
      tool.authorization =
        cred.type === "bearer" ? cred.token : cred.accessToken;
    } else if (server.authorization) {
      tool.authorization = server.authorization;
    }

    if (server.allowedTools) {
      tool.allowed_tools = server.allowedTools;
    }
    if (server.approvalPolicy) {
      tool.require_approval = mapApprovalPolicy(server.approvalPolicy);
    }
    return tool;
  });
}

export type OpenAIProviderConfig = OpenAIBaseConfig &
  (OpenAIDirectConfig | OpenAIBedrockApiKeyConfig | OpenAIBedrockSigV4Config);

class ResponseAccumulator {
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

function* mapEvent(
  event: ResponseStreamEvent,
  acc: ResponseAccumulator,
): Generator<StreamPart> {
  switch (event.type) {
    // --- lifecycle ---
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

    // --- text streaming ---
    case "response.output_text.delta": {
      acc.content += event.delta;
      yield { type: "text-delta", text: event.delta };
      break;
    }

    // --- refusal ---
    case "response.refusal.delta": {
      acc.finishReason = "refused";
      yield { type: "refusal", text: event.delta };
      break;
    }

    // --- reasoning / thinking ---
    case "response.reasoning_summary_text.delta": {
      yield { type: "thinking", text: event.delta };
      break;
    }

    // --- function / tool calls ---
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

    // --- error ---
    case "error": {
      throw mapError(event, OPENAI);
    }

    // --- escape hatch for everything else ---
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

function buildOpenAIClient(config: OpenAIProviderConfig): OpenAI {
  if (!("awsRegion" in config) || !config.awsRegion) {
    return new OpenAI({ apiKey: config.apiKey });
  }

  const baseURL = `https://bedrock-mantle.${config.awsRegion}.api.aws/v1`;

  if ("awsBedrockApiKey" in config && config.awsBedrockApiKey) {
    return new OpenAI({ baseURL, apiKey: config.awsBedrockApiKey });
  }

  if ("awsCredentials" in config && config.awsCredentials) {
    return new OpenAI({
      baseURL,
      apiKey: "bedrock-sigv4",
      fetch: createSigV4Fetch({
        region: config.awsRegion,
        credentials: config.awsCredentials,
      }),
    });
  }

  return new OpenAI({ baseURL, apiKey: "bedrock" });
}

class OpenAIProvider implements Provider {
  readonly provider = OPENAI;
  readonly runtimeId: string;

  private readonly client: OpenAI;
  private readonly model: string;
  private readonly instructions?: string;
  private readonly useConversations: boolean;
  private readonly mcpServers: McpServerConfig[];
  private readonly vaultStore?: VaultStore;

  constructor(config: OpenAIProviderConfig) {
    this.runtimeId = config.promptId ?? "inline";
    this.model = config.model ?? "gpt-4o";
    this.instructions = config.instructions;
    this.client = buildOpenAIClient(config);
    this.useConversations = !("awsRegion" in config && config.awsRegion);
    this.mcpServers = config.mcpServers ?? [];
    this.vaultStore = config.vaultStore;
  }

  async send(params: RequestParams): Promise<Response> {
    return collectStream(await this.stream(params));
  }

  async stream(params: RequestParams): Promise<StreamResult> {
    let resolveResponse!: (r: Response) => void;
    let rejectResponse!: (e: unknown) => void;
    const responsePromise = new Promise<Response>((res, rej) => {
      resolveResponse = res;
      rejectResponse = rej;
    });
    return {
      stream: this.runStream(params, resolveResponse, rejectResponse),
      response: responsePromise,
    };
  }

  private async resolveSessionParams(
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    if (this.useConversations) {
      const id = sessionId ?? (await this.client.conversations.create()).id;
      return { conversation: { id } };
    }
    return sessionId ? { previous_response_id: sessionId } : {};
  }

  private async *runStream(
    params: RequestParams,
    resolveResponse: (r: Response) => void,
    rejectResponse: (e: unknown) => void,
  ): AsyncIterable<StreamPart> {
    try {
      const sessionParams = await this.resolveSessionParams(params.sessionId);

      const credentials = params.vaultIds?.length
        ? await this.resolveCredentials(params.vaultIds)
        : undefined;

      const mcpTools =
        this.mcpServers.length > 0
          ? toMcpTools(this.mcpServers, credentials)
          : undefined;

      let input: ResponseInput = openaiTransformer.toInput(
        params.messages,
      ) as ResponseInput;

      if (params.toolResults?.length) {
        const toolInputs: ResponseInput = params.toolResults.map((tr) => {
          if (tr.approved !== undefined) {
            return {
              type: "mcp_approval_response" as const,
              approval_request_id: tr.toolUseId,
              approve: tr.approved,
            };
          }
          return {
            type: "function_call_output" as const,
            call_id: tr.toolUseId,
            output: tr.output ?? "",
          };
        });
        input = [...toolInputs, ...input];
      }

      const rawStream = await this.client.responses.create({
        model: this.model,
        input,
        stream: true,
        ...(this.instructions ? { instructions: this.instructions } : {}),
        ...(mcpTools ? { tools: mcpTools } : {}),
        ...sessionParams,
        ...params.providerOptions,
      } as ResponseCreateParamsStreaming);

      const acc = new ResponseAccumulator();
      for await (const rawEvent of rawStream) {
        yield* mapEvent(rawEvent, acc);
      }

      const response = acc.toResponse();
      yield { type: "finish", response };
      resolveResponse(response);
    } catch (err) {
      const mapped =
        err instanceof ThalamusError ? err : (mapError(err, OPENAI) as Error);
      yield { type: "error", error: mapped };
      rejectResponse(mapped);
    }
  }

  async createVault(options: VaultOptions): Promise<Vault> {
    if (!this.vaultStore) {
      throw new ThalamusError(
        "Pass a vaultStore to createOpenAIProvider() to use vault operations",
        {
          provider: OPENAI,
          isRetryable: false,
        },
      );
    }
    const record = await this.vaultStore.createVault(options);
    return new LocalVault(record.id, OPENAI, this.vaultStore);
  }

  async getVault(vaultId: string): Promise<Vault> {
    if (!this.vaultStore) {
      throw new ThalamusError(
        "vaultStore is required for OpenAI vault support",
        {
          provider: OPENAI,
          isRetryable: false,
        },
      );
    }
    const record = await this.vaultStore.getVault(vaultId);
    if (!record) {
      throw new ThalamusError(`Vault not found: ${vaultId}`, {
        provider: OPENAI,
        isRetryable: false,
      });
    }
    return new LocalVault(record.id, OPENAI, this.vaultStore);
  }

  private async resolveCredentials(
    vaultIds: string[],
  ): Promise<Map<string, Credential>> {
    if (!this.vaultStore) {
      throw new ThalamusError(
        "vaultStore is required to resolve vault credentials",
        { provider: OPENAI, isRetryable: false },
      );
    }
    const merged = new Map<string, Credential>();
    for (const vid of vaultIds) {
      const stored = await this.vaultStore.getAll(vid);
      for (const s of stored) {
        if (!merged.has(s.name)) {
          merged.set(s.name, s.credential);
        }
      }
    }
    return merged;
  }

  async createSession(_options?: SessionOptions): Promise<string> {
    return crypto.randomUUID();
  }

  async endSession(_sessionId: string): Promise<void> {
    // No-op for stateless provider.
  }
}

export function createOpenAIProvider(config: OpenAIProviderConfig): Provider {
  return new OpenAIProvider(config);
}
