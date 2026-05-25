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

console.log(response.content);
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
console.log(response.content);
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
| `onTextDelta` | `text-delta` | Incremental text output |
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
| `@novu/thalamus` | Core types, errors, `thalamus` factory, `createMemoryVaultStore` |
| `@novu/thalamus/anthropic` | `createAnthropicProvider` |
| `@novu/thalamus/openai` | `createOpenAIProvider` |
| `@novu/thalamus/vault` | Vault types and `VaultStore` interface |
| `@novu/thalamus/durable` | `redis()`, `cloudflare()`, `DurableBackend`, `DurabilityBackend`, `EdgeObserver` |
| `@novu/thalamus/webhook` | `createWebhookHandler` — HMAC-verified webhook receiver |

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
