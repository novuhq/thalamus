# Future Plans

Tracked enhancements and design decisions deferred from the initial implementation.

---

## Client-Side Tool Execution (Custom Tools / MCP Round-Trips)

**Problem:** All three providers support a pattern where the agent asks the client to execute a tool and send back results. We handle the first half — `finishReason: 'requires-action'` with `actionsRequired` — but there's no way to send results back.

**Provider-native mechanisms:**
- **Anthropic:** `agent.custom_tool_use` → expects `user.custom_tool_result` event
- **OpenAI:** custom tool calls / MCP approval requests → expects tool output in next `input`
- **Bedrock:** `returnControl` → expects `returnControlInvocationResults` in next `InvokeAgent` call

**Proposed solution:** Add `ToolResult` type and `toolResults` field to `RequestParams`:

```typescript
export interface ToolResult {
  toolUseId: string;
  output: string;
  isError?: boolean;
}

export interface RequestParams {
  message: Message;
  sessionId?: string;
  history?: Message[];
  toolResults?: ToolResult[];
  providerOptions?: Record<string, unknown>;
}
```

**Consumer flow:**
```typescript
const result = await provider.stream({ message, sessionId });
// consume stream → finishReason: 'requires-action', actionsRequired: [...]

// execute tool locally, then resume:
const result2 = await provider.stream({
  message,
  sessionId,
  toolResults: [{ toolUseId: 'xxx', output: '{"temp": 72}' }],
});
```

**Provider mapping:**
- Anthropic: sends `user.custom_tool_result` events via `sessions.events.send()`
- OpenAI: includes tool output items in the `input` array
- Bedrock: passes `returnControlInvocationResults` in `sessionState`

**When:** Implement when building out the OpenAI/Bedrock providers or when a Novu worker needs custom tool support.

---

## Explicit Session Lifecycle (createSession)

**Problem:** `stream()` currently creates a session implicitly when `sessionId` is absent, but there's no place to pass session-level config. Anthropic sessions need `vault_ids` (MCP credentials), `resources` (files, GitHub repos), and environment config at creation time. These are session-level concerns, not turn-level — they don't belong in `RequestParams`.

**Why it matters:** In the Novu use case, different users/tenants need different vault credentials per session. Putting `vaultIds` in the provider factory config would lock every session to the same vaults.

**How provider session setup works today:**
- **Anthropic:** `sessions.create({ agent, environment_id, vault_ids, resources })` — vaults for MCP auth, file/repo resources mounted into the container
- **OpenAI:** No explicit session — response ID chaining via `previous_response_id`. Tools (including MCP servers) passed per-request.
- **Bedrock:** Caller generates a UUID. Agent config (action groups, knowledge bases) is pre-configured in AWS console.

**Proposed solution:** Add `createSession()` to the `Provider` interface and make `stream()` always require a `sessionId`:

```typescript
export interface Provider {
  readonly provider: string;
  readonly runtimeId: string;

  createSession(options?: Record<string, unknown>): Promise<string>;
  send(params: RequestParams): Promise<Response>;
  stream(params: RequestParams): Promise<StreamResult>;
  endSession(sessionId: string): Promise<void>;
}
```

Each provider types its own session options:

```typescript
// Anthropic — full session config
const sessionId = await provider.createSession({
  vaultIds: ['vlt_xxx'],
  resources: [
    { type: 'github_repository', url: '...', authorizationToken: '...' },
    { type: 'file', fileId: 'file_xxx', mountPath: '/workspace/data.csv' },
  ],
});

// OpenAI — no-op, returns empty string (sessions are implicit)
const sessionId = await provider.createSession();

// Bedrock — generates UUID
const sessionId = await provider.createSession();

// Messaging is always turn-level, sessionId required
const result = await provider.stream({
  message: { role: MessageRole.USER, content: 'Fix the bug' },
  sessionId,
});
```

**Benefits:**
- Typed session config per provider without polluting shared `RequestParams`
- Clean separation: session lifecycle is explicit, messaging is just messaging
- No ambiguity about when sessions are created or what config they use

**When:** Implement when Novu workers need per-tenant MCP/vault configuration or when adding GitHub repo / file resource support.
