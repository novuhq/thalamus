# @novu/thalamus

Provider-agnostic runtime for managed AI agents. One interface, same messages in, same streaming events out, same credential vault — regardless of which provider runs the agent.

## Why

Every AI provider ships its own session model, event shapes, streaming format, and credential management. Supporting multiple providers means writing — and maintaining — separate codepaths for each.

Thalamus gives you a single `Provider` interface that normalizes all of it, so your application code stays the same when the provider underneath changes.

## Quick Start

```bash
npm install @novu/thalamus @anthropic-ai/sdk  # or: openai
```

```typescript
import { createAnthropicProvider, MessageRole } from '@novu/thalamus';

const provider = createAnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY,
  agentId: 'agent_01J...',
  environmentId: 'env_01J...',
});

const response = await provider.send({
  messages: [{ role: MessageRole.USER, content: 'What can you help me with?' }],
});

console.log(response.messages); // every assistant message produced this turn
console.log(response.sessionId); // pass back on the next turn to continue
```

Swap the provider — everything else stays the same:

```typescript
import { createOpenAIProvider } from '@novu/thalamus';

const provider = createOpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4o',
  instructions: 'You are a helpful assistant.',  // optional system prompt
  promptId: 'prompt_abc123',                      // optional OpenAI prompt template ID
});
```

## Supported Providers

| Provider | Subpath | Peer dependency |
|---|---|---|
| Anthropic Managed Agents | `@novu/thalamus/anthropic` | `@anthropic-ai/sdk` |
| Anthropic via AWS | `@novu/thalamus/anthropic` | `@anthropic-ai/aws-sdk` |
| OpenAI Responses API | `@novu/thalamus/openai` | `openai` |
| OpenAI via AWS Bedrock Mantle | `@novu/thalamus/openai` | `openai` (+ `@smithy/signature-v4` `@aws-crypto/sha256-js` for SigV4) |

Bedrock Mantle supports two auth modes: pass `awsBedrockApiKey` for API key auth, or `awsCredentials` (access key + secret + optional session token) for SigV4 signing. SigV4 requires the additional peer deps listed above.

Anthropic via AWS requires an explicit `apiKey` (AWS Console API key) when `awsRegion` is set. Thalamus does not fall back to the host default AWS credential chain or IAM SigV4 signing.

## Core API

### Provider

Every provider implements:

```typescript
interface Provider {
  readonly provider: string;
  readonly runtimeId: string;
  send(params: RequestParams): SendResult;  // or Promise<WebhookSendResult> in webhook mode
  createVault(options: VaultOptions): Promise<Vault>;
  getVault(vaultId: string): Promise<Vault>;
  createSession(options?: SessionOptions): Promise<string>;
  endSession(sessionId: string): Promise<void>;
}

interface WebhookSendResult {
  sessionId: string;
  runId: string;
}
```

When [`durable`](#durable-sessions) is configured with a webhook (edge observer), TypeScript narrows `send()` to return `Promise<WebhookSendResult>` (the `sessionId` and `runId`) instead of `SendResult`.

There's also a convenience namespace:

```typescript
import { thalamus } from '@novu/thalamus';

const provider = thalamus.anthropic({ /* config */ });
const provider = thalamus.openai({ /* config */ });
```

### send() and SendResult

`send()` returns a `SendResult` — a `PromiseLike<Response>` you can use in different ways depending on what you need.

#### Pattern 1: Await the full response

The simplest approach. Blocks until the agent finishes its turn.

```typescript
const response = await provider.send({ messages });
console.log(response.messages); // every assistant message produced this turn
console.log(response.finishReason); // 'stop', 'requires-action', etc.
```

#### Pattern 2: Just get the text

Convenience shorthand when you only care about the output string.

```typescript
const text = await provider.send({ messages }).text();
```

#### Pattern 3: Access metadata without waiting

`runId` is available immediately (no await). `sessionId` resolves early — as soon as the stream opens, before the agent finishes. Useful when you need to store references or start parallel work.

```typescript
const result = provider.send({ messages });
console.log(result.runId);              // available instantly
const sid = await result.sessionId;     // resolves early
await result.response;                  // wait for the full response later
```

#### Pattern 4: Fire-and-forget with callbacks

When `onSessionEvents` is set, `send()` starts consuming events immediately — callbacks fire even if you never await the result. Use this when callbacks do all the work and you don't need the return value.

```typescript
const provider = createOpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4o',
  onSessionEvents: (sessionId, runId) => ({
    onTextDelta: ({ text }) => pushToClient(sessionId, text),
    onToolUseDone: ({ toolName }) => console.log(`[${runId}] used ${toolName}`),
    onFinish: ({ response }) => saveResponse(sessionId, response),
  }),
});

provider.send({ messages }); // no await needed — callbacks handle everything
```

You can still `await` if you want to catch errors or check the `finishReason`:

```typescript
const response = await provider.send({ messages });
if (response.finishReason === 'requires-action') { /* handle approval */ }
```

Without `onSessionEvents`, consumption is **lazy** — nothing happens until you access `.sessionId`, `.response`, or `await` the result.

#### Sequential turns

Messages to the same session are processed one at a time, in order. If you send a message while the agent is still working on the previous one, it's held and dispatched when the session is ready.

```typescript
const s1 = provider.send({ sessionId, messages: [{ role: MessageRole.USER, content: 'First' }] });
const s2 = provider.send({ sessionId, messages: [{ role: MessageRole.USER, content: 'Second' }] });
const s3 = provider.send({ sessionId, messages: [{ role: MessageRole.USER, content: 'Third' }] });

// All three resolve — s2 waits for s1, s3 waits for s2
const [r1, r2, r3] = await Promise.all([s1, s2, s3]);
```

Tool results (`toolResults`) always resolve the current turn immediately — they never wait in line. Different sessions don't block each other.

Consumers can react to the `status-change: queued` event to show a waiting indicator:

```typescript
onSessionEvents: ({ sessionId }) => ({
  onStatusChange: ({ status }) => {
    if (status === 'queued') showWaitingIndicator(sessionId);
  },
}),
```

This works in both streaming mode and [webhook mode](#durable-sessions--webhook-delivery).

---

Every `send()` gets a fresh `runId` for correlating callbacks, logs, and webhook events back to a specific turn. The same `runId` is passed to `onSessionEvents(sessionId, runId)` and echoed in webhook payloads.

Provider-specific options (temperature, max tokens, etc.) pass through via `providerOptions`:

```typescript
await provider.send({
  messages,
  providerOptions: { temperature: 0.7, max_output_tokens: 4096 },
});
```

### Streaming with Callbacks

Callbacks are set at **provider creation time** via `onSessionEvents` — not per `send()` call. This lets the same factory re-attach callbacks when [recovering durable sessions](#durable-sessions) after a restart.

The factory receives `sessionId` (route events to the right client) and `runId` (correlate back to a specific `send()` invocation).

#### Async callbacks and ordering

Callbacks can be sync or async. When a callback is async (returns a `Promise`), the SDK **waits for it to finish before processing the next event**. This guarantees events are handled one at a time, in order:

```typescript
onSessionEvents: (sessionId, runId) => ({
  // Sync callback — returns immediately.
  // Great for pushing to a WebSocket or appending to a string.
  onTextDelta: ({ text }) => socket.emit('delta', text),

  // Async callback — the SDK waits for it to complete.
  // The next event won't be processed until this DB write finishes.
  // This prevents race conditions without needing locks.
  onToolUseDone: async ({ toolName, input }) => {
    const existing = await db.planCards.findOne({ sessionId });
    if (existing) {
      await db.planCards.updateOne(existing._id, { $push: { tools: toolName } });
    } else {
      await db.planCards.insertOne({ sessionId, toolName });
    }
  },
}),
```

Why this matters: without sequential processing, two rapid `onToolUseDone` events could both read an empty DB, both insert, and create duplicates. With async callbacks, the second event always sees the first event's writes.

This works identically in streaming mode and [webhook mode](#durable-sessions--webhook-delivery) — same callbacks, same guarantee.

**Rule of thumb:** Keep `onTextDelta` sync for fast streaming. Use `async` for `onToolUseDone`/`onFinish` where correctness matters more than speed.

If you have async work that shouldn't block the next event (like analytics), just don't return the promise:

```typescript
onToolUseDone: ({ toolName }) => {
  void analytics.track('tool_used', { toolName }); // fire-and-forget
},
```

<details>
<summary>All available callbacks</summary>

| Callback | Event | Description |
|---|---|---|
| `onPart` | all | Fires for every event, before type-specific callbacks |
| `onMessage` | `message` | One complete assistant message (all providers) |
| `onTextDelta` | `text-delta` | Incremental text output (OpenAI only) |
| `onThinking` | `thinking` | Model reasoning content |
| `onRefusal` | `refusal` | Model refused to respond |
| `onToolUseStart` | `tool-use-start` | Tool call initiated |
| `onToolUseDelta` | `tool-use-delta` | Streaming tool call arguments |
| `onToolUseDone` | `tool-use-done` | Tool call completed with parsed input |
| `onToolUseResult` | `tool-use-result` | Tool execution result (`content` blocks) |
| `onMcpToolsDiscovered` | `mcp-tools-discovered` | MCP server tools discovered |
| `onStatusChange` | `status-change` | Agent status changed |
| `onStreamStart` | `stream-start` | Stream opened, includes `sessionId` |
| `onFinish` | `finish` | Stream complete, includes final `Response` |
| `onError` | `error` | Error occurred |
| `onProviderEvent` | `provider-event` | Unmapped provider-specific event (escape hatch) |

> **`message` vs `text-delta`:** `message` fires once per complete assistant message and is emitted by **all** providers — use `onMessage` for provider-agnostic code. `text-delta` is a streaming-only enhancement for live typing, emitted **only** by providers that stream tokens (OpenAI); Anthropic does not emit `text-delta`. The final `Response.messages` holds every `message` of the turn.

</details>

### Messages

Normalized format supporting text and multimodal content:

```typescript
interface Message {
  role: MessageRole;  // 'user' | 'assistant' | 'system'
  content: string | ContentPart[];
}

// ContentPart variants:
// { type: 'text', text: string }
// { type: 'image', data: string, mediaType: string }
// { type: 'image-url', url: string }
// { type: 'file', data: string, mediaType: string, name?: string }
```

> [!IMPORTANT]
> **Providers handle `messages` differently — be aware of this when swapping or recovering sessions.**
>
> You pass the same `messages[]` to every provider, but Anthropic Managed Agent sessions **do not accept assistant/system rows as native input**. History lives on the session server-side; send only accepts new **user** input.
>
> - **OpenAI** — roles pass through normally.
> - **Anthropic** — if you include prior `assistant` or `system` rows (usually only after a **dead or expired session**), Thalamus has to fold them into the next user message as a `[Context]` text block. This is a **workaround**, not equivalent to real thread replay — prefer keeping the session alive and sending one new `USER` message when you can.
>
> **Avoid:** passing full chat history on every turn while a `sessionId` is still valid — you may duplicate context and waste tokens.

### Sessions

Pass `sessionId` from a previous response to continue a conversation:

```typescript
const first = await provider.send({
  messages: [{ role: MessageRole.USER, content: 'Remember: my name is Alice' }],
});

const second = await provider.send({
  sessionId: first.sessionId,
  messages: [{ role: MessageRole.USER, content: 'What is my name?' }],
});
```

How `sessionId` maps to the underlying provider (Anthropic sessions, OpenAI conversations, response chaining on Bedrock) is handled internally.

### Per-turn agent overrides

Pass `agent` on `send()` to filter MCP servers or inject custom tools for a single turn. Overrides are per-request — no in-memory state and no separate update API.

```typescript
// Provider configured with github, slack, linear at creation time
const provider = createOpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4o',
  mcpServers: [
    { name: 'github', url: 'https://api.githubcopilot.com/mcp/' },
    { name: 'slack', url: 'https://mcp.slack.com/sse' },
    { name: 'linear', url: 'https://mcp.linear.app/sse' },
  ],
});

// Only GitHub MCP for this subscriber's turn
await provider.send({
  sessionId,
  messages: [{ role: MessageRole.USER, content: 'Summarize my open PRs' }],
  agent: {
    mcpServers: [
      { name: 'github', url: 'https://api.githubcopilot.com/mcp/' },
    ],
  },
});
```

`AgentSessionConfig` supports three fields:

| Field | Purpose |
|---|---|
| `mcpServers` | Replace the MCP servers active for this turn |
| `tools` | Custom tools (`AgentToolConfig`: `name`, `description`, `inputSchema`) — mapped to OpenAI function tools or Anthropic custom tools |
| `providerTools` | Provider-specific tool payloads passed through as-is (e.g. `{ type: 'agent_toolset_20260401' }` on Anthropic) |

On **Anthropic**, the provider calls `sessions.update()` before dispatch. On **OpenAI**, overrides are applied when building the API request. In webhook mode, `agent` survives the edge serialize/deserialize round-trip via `SerializedRequestParams`.

### AbortSignal

Agent turns can run for a long time — the model may chain multiple tool calls, hit slow MCP servers, or produce lengthy output. You need a way to stop a request when the user clicks "stop generating," navigates away, or when your server is shutting down gracefully.

Pass an `AbortSignal` and the SDK tears down the underlying connection cleanly:

```typescript
const controller = new AbortController();

const result = provider.send({
  messages,
  abortSignal: controller.signal,
});

// User clicked stop, or server is shutting down
controller.abort();

try {
  await result;
} catch (err) {
  if (err instanceof AbortedError) {
    // err.sessionId is available when known, so you can resume later or clean up
  }
}
```

## MCP Servers

For OpenAI, configure MCP servers at provider creation:

```typescript
const provider = createOpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4o',
  mcpServers: [
    { name: 'github', url: 'https://api.githubcopilot.com/mcp/', approvalPolicy: 'never' },
  ],
});
```

For Anthropic, MCP servers are configured in the Anthropic console at the environment level.

Tool events include a `source` field (`{ type: 'builtin' }`, `{ type: 'custom' }`, or `{ type: 'mcp', serverName: '...' }`) so you can tell where each tool call originated.

## Vault & Credentials

When your agent calls MCP servers on behalf of different users, each user needs their own credentials (OAuth tokens, API keys, etc.). Vaults are per-user credential containers that the SDK injects into MCP requests automatically.

The API is the same regardless of provider. Anthropic vaults are managed server-side via the Vault API; OpenAI vaults are stored in a `VaultStore` you provide and injected at call time.

```typescript
const vault = await provider.createVault({ name: 'Alice' });
await vault.add('github', { type: 'bearer', token: 'ghp_xxx' });

await provider.send({
  messages: [{ role: MessageRole.USER, content: 'List my GitHub repos' }],
  vaultIds: [vault.id],
});
```

For OpenAI, pass a `VaultStore` when creating the provider. `createMemoryVaultStore()` is included for development; implement the `VaultStore` interface with your database for production:

```typescript
import { createMemoryVaultStore } from '@novu/thalamus';

const provider = createOpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY,
  mcpServers: [{ name: 'github', url: 'https://api.githubcopilot.com/mcp/' }],
  vaultStore: createMemoryVaultStore(),
});
```

Anthropic needs no extra configuration — vaults are managed via the Anthropic API automatically.

## Approval Flow

When a tool requires human confirmation, the response finishes with `finishReason: 'requires-action'` and a list of pending actions. Your app shows them to the user, collects a decision, and sends it back:

```typescript
const response = await provider.send({ messages });

if (response.finishReason === 'requires-action') {
  for (const action of response.actionsRequired) {
    console.log(`${action.toolName} wants to run with`, action.input);
  }

  await provider.send({
    messages: [],
    sessionId: response.sessionId,
    toolResults: response.actionsRequired.map(a => ({
      toolUseId: a.toolUseId,
      approved: true,
    })),
  });
}
```

## Durable Sessions

Agent sessions can run for minutes. During that time your server might redeploy, the SSE connection might drop due to a proxy timeout or TCP reset, or the process might crash. Without durability, the session is lost and the user has to start over.

The `durable` option accepts two kinds of backends — **checkpoint** and **edge observer** — which solve the problem differently.

Both require `onSessionEvents` to be set, so the provider knows how to re-attach callbacks when recovering sessions after a restart.

### Checkpoint backends (Redis)

The SDK holds the SSE connection in your Node.js process. As events arrive, it saves a checkpoint (session ID + last event cursor) to storage. On connection drops, it reconnects from the last checkpoint with up to 3 retries. Events are deduplicated by sequence number (OpenAI) or event ID (Anthropic), so callbacks never fire twice.

On process restart, the provider reads active checkpoints and resumes from the last cursor.

```typescript
import { redis } from '@novu/thalamus/durable';
import { createOpenAIProvider } from '@novu/thalamus';
import Redis from 'ioredis';

const provider = createOpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4o',
  durable: redis(new Redis()),
  onSessionEvents: (sessionId, runId) => ({
    onTextDelta: ({ text }) => pushToClient(sessionId, text),
    onFinish: ({ response }) => saveResponse(sessionId, response),
  }),
});
```

**Limitations:** the SSE connection lives in your process — if it crashes, events generated between the crash and restart are only recoverable if the provider supports resuming from a cursor. Long-lived connections also tie up server resources and don't work well with serverless or auto-scaling.

```typescript
const backend = redis(redisClient);
const backend = redis(redisClient, { key: 'myapp:sessions' }); // custom hash key
```

### Edge observer (Cloudflare)

Instead of holding the SSE connection in your Node.js process, the edge observer offloads it to a Cloudflare Worker. The Worker maintains a Durable Object per session that:

- Opens the SSE connection to the AI provider on behalf of your app
- Persists every event to SQLite (survives crashes and DO evictions)
- Delivers events to your webhook endpoint with guaranteed at-least-once delivery
- Retries with exponential backoff when your server is unavailable
- Hibernates between retries (zero compute cost)
- Reconstructs full response content for the `finish` event from stored deltas

Your app just needs a webhook endpoint. If it crashes and restarts, the Worker keeps retrying delivery — no reconnection logic, no state to restore.

```typescript
import { cloudflare } from '@novu/thalamus/durable';
import { adaptPinoLogger } from '@novu/thalamus';
import { createWebhookHandler } from '@novu/thalamus/webhook';

// --- Provider setup (sends message, returns sessionId) ---

const provider = createAnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY,
  agentId: 'agent_01J...',
  environmentId: 'env_01J...',
  durable: cloudflare({
    url: 'https://session-observer.your-domain.workers.dev',
    apiKey: process.env.OBSERVER_API_KEY,
    webhook: {
      url: 'https://your-app.com/webhook',
      secret: process.env.WEBHOOK_SECRET,
    },
  }),
});

// In webhook mode, send() returns Promise<WebhookSendResult>
const { sessionId, runId } = await provider.send({
  messages: [{ role: MessageRole.USER, content: 'Hello' }],
});
```

```typescript
// --- Webhook receiver (your Express/Node HTTP server) ---

const handler = createWebhookHandler({
  secret: process.env.WEBHOOK_SECRET,
  logger: adaptPinoLogger(pino), // optional — trace webhook ingress
  onSessionEvents: (sessionId, runId, metadata) => ({
    onTextDelta: ({ text }) => pushToClient(sessionId, text),

    // Async callbacks are awaited — the webhook handler only responds 200
    // after this completes, so the Observer won't send the next event until
    // your DB writes finish. No locks needed.
    onToolUseDone: async ({ toolName, input }) => {
      await db.activities.insertOne({ sessionId, runId, toolName, input });
    },

    onFinish: async ({ response }) => {
      await saveResponse(sessionId, response);
    },
  }),
});

// Express / Node http
app.post('/webhook', (req, res) => handler.express(req, res));

// Web standard Request/Response (Cloudflare Workers, Bun, Deno, Next.js)
export default { fetch: (req) => handler.handle(req) };
```

The factory receives `runId` and `metadata` (from `webhookMetadata` on `send()`). Both are also in headers: `X-Thalamus-Session-Id`, `X-Thalamus-Run-Id`.

**No race conditions:** The Observer delivers events one at a time. It sends an event to your webhook and waits — it won't send the next event until your handler responds with 200. Since `createWebhookHandler` only responds 200 **after** your async callback completes, this means:

1. Observer sends event A → your `onToolUseDone` runs, does its DB write → handler responds 200
2. Observer sends event B → your `onToolUseDone` runs, reads A's data from DB → handler responds 200

Events never overlap. Your callbacks always see the previous callback's side effects. No distributed locks, no in-memory queues, no retry coordination on your side.

**Type safety:** With `durable` + webhook configured, TypeScript narrows `send()` to `Promise<WebhookSendResult>`.

**Multi-node safe:** No in-memory state, works behind any load balancer. The Observer guarantees ordering regardless of which node receives the request.

**Sequential turns in webhook mode:** The edge observer queues messages per session automatically. When you send a message while another turn is active, the observer holds it and sends a `status-change: queued` webhook. When the active turn completes, the observer sends a `queue-ready` webhook — thalamus's webhook handler intercepts it and dispatches the queued message via the provider SDK. This is transparent when using `provider.createWebhookHandler()`.

For multi-provider setups (one webhook handler serving many providers), pass `onQueueReady` to `createWebhookHandler()` to handle `queue-ready` events manually:

```typescript
const handler = createWebhookHandler({
  secret: process.env.WEBHOOK_SECRET,
  onSessionEvents: (ctx) => myHandlers(ctx),
  onQueueReady: async ({ sessionId, runId, turnId, request }) => {
    const provider = await resolveProvider(request.webhookMetadata);
    await provider.dispatchQueued(sessionId, runId, turnId, request);
  },
});
```

For a production reference implementation of the companion Cloudflare Worker, see [`enterprise/workers/thalamus-observer`](https://github.com/novuhq/novu/tree/next/enterprise/workers/thalamus-observer) in the Novu platform repository.

### Custom backend

Implement the `DurabilityBackend` interface for checkpoint-based durability with any storage:

```typescript
interface DurabilityBackend {
  save(checkpoint: SessionCheckpoint): Promise<void>;
  remove(sessionId: string): Promise<void>;
  getActive(): Promise<SessionCheckpoint[]>;
}
```

## Lifecycle Logging

Opt-in structured logging for debugging the durable agent pipeline (observe → dispatch → webhook → callbacks). **Default is silent** — existing integrations are unchanged without `logger`.

The SDK logs infrastructure stages only. Agent/business events belong in `onSessionEvents` callbacks.

### Enable on provider creation

```typescript
import { thalamus, adaptPinoLogger } from '@novu/thalamus';
import { cloudflare } from '@novu/thalamus/durable';

const log = adaptPinoLogger(pino); // maps Thalamus (msg, ctx) → Pino (ctx, msg)

const provider = thalamus.anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  agentId: 'agent_01J...',
  environmentId: 'env_01J...',
  durable: cloudflare({ url, apiKey, webhook: { url, secret } }),
  logger: log, // false | 'silent' | 'debug' | custom adapter
  onSessionEvents: (ctx) => ({ ... }),
});
```

| `logger` | Behavior |
|---|---|
| omitted / `false` / `"silent"` | No SDK logs |
| `"debug"` | Built-in console output for local scripts |
| custom object | Your adapter; partial implementations supported (missing methods no-op) |

Exported helpers: `resolveLogger`, `silentLogger`, `createConsoleLogger`, `adaptPinoLogger`, `logErrorMessage`.

### Webhook handler

When the webhook endpoint is a singleton (separate from provider creation), pass the same logger:

```typescript
import { createWebhookHandler } from '@novu/thalamus/webhook';

const handler = createWebhookHandler({
  secret: process.env.WEBHOOK_SECRET,
  logger: log,
  onSessionEvents: (ctx) => ({ ... }),
});
```

For single-provider apps, `provider.createWebhookHandler({ secret })` inherits `logger` and `onSessionEvents` from provider config.

### Correlation fields

Each log includes a `stage` string plus `sessionId`, `runId`, `turnId`, `provider`, `eventType`, `durationMs`, and `error` when relevant — enough to trace a turn through observe, dispatch, webhook delivery, and callback execution.

<details>
<summary>Lifecycle stages</summary>

| Stage | Level | When |
|---|---|---|
| `send.start` / `send.complete` | info | Webhook send lifecycle |
| `edge.observe.start` / `edge.observe.ok` / `edge.observe.failed` | info / error | Edge observer registration |
| `edge.dispatch.sent` | info | Anthropic events dispatched after observe |
| `dispatch.start` / `dispatch.sent` / `dispatch.input` | debug / info | OpenAI background dispatch |
| `dispatch.events` | debug | Anthropic session events payload |
| `session.create` | info | New Anthropic session |
| `conversation.create` | debug | OpenAI conversation created |
| `stream.reconnect` | warn | Checkpoint SSE reconnect |
| `stream.error` | error | OpenAI stream-mode failure |
| `recovery.failed` / `recovery.stream.failed` | error | Durable session recovery |
| `webhook.received` / `webhook.handled` | debug | Webhook ingress + callback success |
| `webhook.missing-signature` / `webhook.invalid-signature` / `webhook.invalid-payload` | warn | Webhook auth/validation |
| `webhook.callback.failed` | error | Callback threw |

</details>

## Error Handling

All errors extend `ThalamusError` with `provider` and `isRetryable` fields:

| Error | Retryable | When |
|---|---|---|
| `ProviderAuthError` | No | Invalid API key or unauthorized |
| `ProviderRateLimitError` | Yes | Rate limit exceeded (includes `retryAfterMs`) |
| `ProviderUnavailableError` | Yes | Provider temporarily unavailable |
| `ProviderResponseError` | No | Invalid response from provider |
| `SessionExpiredError` | Yes | Session expired or archived (includes `sessionId`) |
| `AbortedError` | No | Request cancelled via `AbortSignal` |
| `VaultNotFoundError` | No | Vault does not exist |
| `CredentialExpiredError` | No | Credential expired with no refresh config |
| `McpServerError` | 5xx only | MCP server returned an error |

```typescript
import { ThalamusError, ProviderRateLimitError, AbortedError } from '@novu/thalamus';

try {
  await provider.send({ messages });
} catch (err) {
  if (err instanceof AbortedError) {
    console.log('Cancelled, session:', err.sessionId);
  } else if (err instanceof ProviderRateLimitError) {
    await sleep(err.retryAfterMs ?? 5000);
  } else if (err instanceof ThalamusError && err.isRetryable) {
    // generic retry
  }
}
```

## Package Structure

| Subpath | Contents |
|---|---|
| `@novu/thalamus` | Core types, errors, `thalamus` factory, `createMemoryVaultStore`, logger helpers |
| `@novu/thalamus/anthropic` | `createAnthropicProvider` |
| `@novu/thalamus/openai` | `createOpenAIProvider` |
| `@novu/thalamus/vault` | Vault types and `VaultStore` interface |
| `@novu/thalamus/durable` | `redis()`, `cloudflare()`, `DurableBackend`, `DurabilityBackend`, `EdgeObserver` |
| `@novu/thalamus/webhook` | `createWebhookHandler` — HMAC-verified webhook receiver (optional `logger`) |

Tree-shakeable — install and import only the provider you use. Zero runtime dependencies; only peer deps for the provider SDKs.

## Contributing

```bash
pnpm install
pnpm test          # run tests
pnpm build         # build ESM + CJS
pnpm typecheck     # type check
pnpm lint          # lint with Biome
```

## License

TBD
