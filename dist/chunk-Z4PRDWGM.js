import {
  ANTHROPIC,
  SessionExpiredError,
  ThalamusError,
  createStreamResult
} from "./chunk-LQAFAVC6.js";

// src/anthropic/anthropic.provider.ts
import Anthropic, { APIError } from "@anthropic-ai/sdk";

// src/anthropic/anthropic.transformer.ts
function toContentBlocks(content) {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  const blocks = [];
  for (const part of content) {
    switch (part.type) {
      case "text":
        blocks.push({ type: "text", text: part.text });
        break;
      case "image":
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: part.mediaType,
            data: part.data
          }
        });
        break;
      case "image-url":
        blocks.push({ type: "image", source: { type: "url", url: part.url } });
        break;
      case "file":
        blocks.push({
          type: "document",
          source: {
            type: "base64",
            media_type: part.mediaType,
            data: part.data
          },
          title: part.name ?? null
        });
        break;
    }
  }
  return blocks;
}

// src/anthropic/anthropic.vault.ts
var AnthropicVault = class {
  id;
  provider = ANTHROPIC;
  client;
  agentId;
  constructor(id, client, agentId) {
    this.id = id;
    this.client = client;
    this.agentId = agentId;
  }
  async resolveMcpServerUrl(name) {
    const agent = await this.client.beta.agents.retrieve(this.agentId);
    const server = (agent.mcp_servers ?? []).find((s) => s.name === name);
    if (!server) {
      const available = (agent.mcp_servers ?? []).map((s) => s.name).join(", ");
      throw new Error(
        `No MCP server named "${name}" on agent ${this.agentId}. Available: ${available}`
      );
    }
    return server.url;
  }
  toAuth(serverUrl, credential) {
    if (credential.type === "bearer") {
      const auth2 = {
        type: "static_bearer",
        mcp_server_url: serverUrl,
        token: credential.token
      };
      return auth2;
    }
    const auth = {
      type: "mcp_oauth",
      mcp_server_url: serverUrl,
      access_token: credential.accessToken,
      ...credential.expiresAt ? { expires_at: credential.expiresAt } : {},
      ...credential.refresh && {
        refresh: {
          refresh_token: credential.refresh.refreshToken,
          token_endpoint: credential.refresh.tokenEndpoint,
          client_id: credential.refresh.clientId,
          token_endpoint_auth: credential.refresh.clientSecret ? {
            type: "client_secret_basic",
            client_secret: credential.refresh.clientSecret
          } : { type: "none" },
          scope: credential.refresh.scopes
        }
      }
    };
    return auth;
  }
  async add(name, credential) {
    const url = await this.resolveMcpServerUrl(name);
    await this.client.beta.vaults.credentials.create(this.id, {
      display_name: name,
      auth: this.toAuth(url, credential)
    });
  }
  async update(name, credential) {
    await this.remove(name);
    await this.add(name, credential);
  }
  async remove(name) {
    const creds = [];
    for await (const c of this.client.beta.vaults.credentials.list(this.id)) {
      creds.push(c);
    }
    const match = creds.find((c) => c.display_name === name);
    if (!match) {
      throw new Error(`Credential "${name}" not found in vault ${this.id}`);
    }
    await this.client.beta.vaults.credentials.delete(match.id, {
      vault_id: this.id
    });
  }
  async list() {
    const result = [];
    for await (const c of this.client.beta.vaults.credentials.list(this.id)) {
      result.push({
        name: c.display_name ?? "",
        type: c.auth?.type === "static_bearer" ? "bearer" : "oauth",
        status: "active",
        createdAt: c.created_at,
        updatedAt: c.updated_at
      });
    }
    return result;
  }
  async destroy() {
    await this.client.beta.vaults.delete(this.id);
  }
};

// src/anthropic/anthropic.provider.ts
function mapStopReason(reason) {
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
function mapSessionError(raw) {
  const obj = raw;
  const msg = obj?.message ?? String(raw);
  const isAuth = obj?.type === "authentication_error";
  return new ThalamusError(msg, { provider: ANTHROPIC, isRetryable: !isAuth });
}
function mapStreamError(err, sessionId) {
  if (sessionId && err instanceof APIError) {
    const status = err.status;
    if (status === 404 || status === 410) {
      return new SessionExpiredError(
        `Session ${sessionId} has expired or been archived`,
        { provider: ANTHROPIC, sessionId, cause: err }
      );
    }
  }
  if (err instanceof ThalamusError) return err;
  return new ThalamusError(String(err), {
    provider: ANTHROPIC,
    isRetryable: false,
    cause: err
  });
}
function buildSendEvents(params) {
  if (params.toolResults?.length) {
    return params.toolResults.map(toSessionEvent);
  }
  const event = {
    type: "user.message",
    content: params.messages.flatMap((msg) => toContentBlocks(msg.content))
  };
  return [event];
}
function toSessionEvent(tr) {
  if (tr.approved !== void 0) {
    return {
      type: "user.tool_confirmation",
      tool_use_id: tr.toolUseId,
      result: tr.approved ? "allow" : "deny"
    };
  }
  return {
    type: "user.custom_tool_result",
    custom_tool_use_id: tr.toolUseId,
    content: [{ type: "text", text: tr.output ?? "" }]
  };
}
var ResponseAccumulator = class {
  content = "";
  finishReason = "stop";
  usage;
  actionsRequired = [];
  done = false;
  toResponse(sessionId) {
    return {
      content: this.content,
      sessionId,
      finishReason: this.finishReason,
      usage: this.usage,
      actionsRequired: this.actionsRequired.length > 0 ? this.actionsRequired : void 0
    };
  }
};
function* mapEvent(event, acc) {
  switch (event.type) {
    // --- text streaming ---
    case "agent.message": {
      const e = event;
      for (const block of e.content) {
        if (block.type === "text") {
          acc.content += block.text;
          yield { type: "text-delta", text: block.text };
        }
      }
      break;
    }
    // --- reasoning / thinking ---
    case "agent.thinking": {
      yield { type: "thinking", text: "" };
      break;
    }
    // --- tool calls ---
    case "agent.tool_use": {
      const e = event;
      yield {
        type: "tool-use-done",
        toolName: e.name,
        toolUseId: e.id,
        input: e.input,
        source: { type: "builtin" }
      };
      break;
    }
    case "agent.tool_result": {
      const e = event;
      const output = e.content?.find((b) => b.type === "text");
      yield {
        type: "tool-use-result",
        toolUseId: e.tool_use_id,
        output: output?.type === "text" ? output.text : void 0,
        source: { type: "builtin" }
      };
      break;
    }
    case "agent.mcp_tool_use": {
      const e = event;
      yield {
        type: "tool-use-done",
        toolName: e.name,
        toolUseId: e.id,
        input: e.input,
        source: {
          type: "mcp",
          serverName: e.mcp_server_name ?? ""
        }
      };
      break;
    }
    case "agent.mcp_tool_result": {
      const e = event;
      const output = e.content?.find((b) => b.type === "text");
      yield {
        type: "tool-use-result",
        toolUseId: e.mcp_tool_use_id,
        output: output?.type === "text" ? output.text : void 0,
        source: {
          type: "mcp",
          serverName: ""
        }
      };
      break;
    }
    case "agent.custom_tool_use": {
      const e = event;
      acc.actionsRequired.push({
        type: "tool-confirmation",
        toolUseId: e.id,
        toolName: e.name,
        input: e.input
      });
      acc.finishReason = "requires-action";
      break;
    }
    // --- lifecycle ---
    case "session.status_running": {
      yield { type: "status-change", status: "running" };
      break;
    }
    case "session.status_rescheduled": {
      yield { type: "status-change", status: "retrying" };
      break;
    }
    case "session.status_idle": {
      const e = event;
      yield { type: "status-change", status: "idle" };
      acc.finishReason = mapStopReason(e.stop_reason);
      acc.done = true;
      break;
    }
    case "session.status_terminated": {
      throw new ThalamusError("Session terminated", {
        provider: ANTHROPIC,
        isRetryable: false
      });
    }
    // --- error ---
    case "session.error": {
      const e = event;
      throw mapSessionError(e.error);
    }
    // --- usage ---
    case "span.model_request_end": {
      const e = event;
      if (e.model_usage) {
        acc.usage = {
          inputTokens: e.model_usage.input_tokens,
          outputTokens: e.model_usage.output_tokens,
          totalTokens: e.model_usage.input_tokens + e.model_usage.output_tokens
        };
      }
      break;
    }
    // --- escape hatch for everything else ---
    default: {
      yield {
        type: "provider-event",
        provider: ANTHROPIC,
        event: event.type,
        data: event
      };
      break;
    }
  }
}
async function createClient(config) {
  if ("awsRegion" in config && config.awsRegion) {
    const { AnthropicAws } = await import("@anthropic-ai/aws-sdk");
    return new AnthropicAws({
      awsRegion: config.awsRegion,
      workspaceId: config.awsWorkspaceId
    });
  }
  return new Anthropic({ apiKey: config.apiKey });
}
var AnthropicProvider = class {
  provider = ANTHROPIC;
  runtimeId;
  client;
  config;
  agentId;
  environmentId;
  constructor(config) {
    this.config = config;
    this.agentId = config.agentId;
    this.environmentId = config.environmentId;
    this.runtimeId = config.agentId;
  }
  async getClient() {
    this.client ??= await createClient(this.config);
    return this.client;
  }
  stream(params, callbacks) {
    return createStreamResult(this.runStream(params), callbacks);
  }
  async *runStream(params) {
    try {
      const client = await this.getClient();
      const sessionId = params.sessionId ?? await this.createSession({
        vaultIds: params.vaultIds,
        providerOptions: params.providerOptions
      });
      yield { type: "stream-start", sessionId };
      const sseStream = await client.beta.sessions.events.stream(sessionId);
      const events = buildSendEvents(params);
      const sendParams = { events };
      await client.beta.sessions.events.send(sessionId, sendParams);
      const acc = new ResponseAccumulator();
      for await (const rawEvent of sseStream) {
        yield* mapEvent(rawEvent, acc);
        if (acc.done) break;
      }
      const response = acc.toResponse(sessionId);
      yield { type: "finish", response };
    } catch (err) {
      const error = mapStreamError(err, params.sessionId);
      yield { type: "error", error };
    }
  }
  async createSession(options) {
    const client = await this.getClient();
    const params = {
      agent: this.agentId,
      environment_id: this.environmentId,
      ...options?.vaultIds?.length ? { vault_ids: options.vaultIds } : {},
      ...options?.providerOptions
    };
    const session = await client.beta.sessions.create(params);
    return session.id;
  }
  async endSession(_sessionId) {
  }
  async createVault(options) {
    const client = await this.getClient();
    const result = await client.beta.vaults.create({
      display_name: options.name,
      metadata: options.metadata
    });
    return new AnthropicVault(result.id, client, this.agentId);
  }
  async getVault(vaultId) {
    const client = await this.getClient();
    await client.beta.vaults.retrieve(vaultId);
    return new AnthropicVault(vaultId, client, this.agentId);
  }
};
function createAnthropicProvider(config) {
  return new AnthropicProvider(config);
}

export {
  toContentBlocks,
  createAnthropicProvider
};
//# sourceMappingURL=chunk-Z4PRDWGM.js.map