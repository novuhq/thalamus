---
name: thalamus
description: "Build with @novu/thalamus, a provider-agnostic runtime for managed AI agents. Use when code imports @novu/thalamus, creates AI providers (OpenAI, Anthropic), streams agent responses, manages sessions, configures MCP servers, handles vaults/credentials, implements approval flows, or sets up durable sessions with webhooks."
---

# @novu/thalamus

Provider-agnostic runtime for managed AI agents. One `Provider` interface, same messages in, same streaming events out — regardless of which provider runs the agent.

## Install

```bash
npm install @novu/thalamus
# Then install the peer dependency for your provider:
npm install openai              # for OpenAI
npm install @anthropic-ai/sdk   # for Anthropic
```

## Imports

```typescript
// Main entry — includes both providers + all types
import { createOpenAIProvider, createAnthropicProvider, MessageRole } from '@novu/thalamus';

// Convenience namespace
import { thalamus } from '@novu/thalamus';
const provider = thalamus.openai({ ... });
const provider = thalamus.anthropic({ ... });

// Tree-shakeable subpath imports
import { createOpenAIProvider } from '@novu/thalamus/openai';
import { createAnthropicProvider } from '@novu/thalamus/anthropic';
import { createMemoryVaultStore } from '@novu/thalamus/vault';

// Durable backends
import { redis, cloudflare } from '@novu/thalamus/durable';

// Webhook handler (for edge observer mode)
import { createWebhookHandler } from '@novu/thalamus/webhook';

// Lifecycle logging (optional, default silent)
import {
  adaptPinoLogger,
  createConsoleLogger,
  resolveLogger,
  silentLogger,
} from '@novu/thalamus';

// Errors
import { ThalamusError, ProviderRateLimitError, ProviderAuthError, AbortedError } from '@novu/thalamus';
```

## Creating Providers

### OpenAI (direct)

```typescript
const provider = createOpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4o',             // optional, defaults to 'gpt-4o'
  instructions: '...',          // optional system instructions
  promptId: '...',              // optional OpenAI prompt template ID, sets runtimeId
  mcpServers: [...],            // optional MCP server configs
  vaultStore: createMemoryVaultStore(), // optional, required for vault ops
  onSessionEvents: ({ sessionId, turnId, runId }) => ({ ... }), // optional streaming callbacks
  durable: redis(redisClient),  // optional durability backend
  logger: 'debug',              // optional — false | 'silent' | 'debug' | custom adapter
});
```

### OpenAI via AWS Bedrock (API key)

```typescript
const provider = createOpenAIProvider({
  awsRegion: 'us-east-1',
  awsBedrockApiKey: process.env.AWS_BEDROCK_API_KEY,
  model: 'anthropic.claude-sonnet-4-20250514',
});
```

### OpenAI via AWS Bedrock (SigV4)

Requires additional peer deps: `@smithy/signature-v4` and `@aws-crypto/sha256-js`.

```typescript
const provider = createOpenAIProvider({
  awsRegion: 'us-east-1',
  awsCredentials: {
    accessKeyId: '...',
    secretAccessKey: '...',
    sessionToken: '...',       // optional
  },
  model: 'anthropic.claude-sonnet-4-20250514',
});
```

### Anthropic Managed Agents (direct)

```typescript
const provider = createAnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY,
  agentId: 'agent_01J...',
  environmentId: 'env_01J...',
  onSessionEvents: ({ sessionId, turnId, runId }) => ({ ... }), // optional
  durable: redis(redisClient),                       // optional
  logger: adaptPinoLogger(pino),                     // optional
});
```

### Anthropic via AWS

Requires peer dependency `@anthropic-ai/aws-sdk` (`npm install @anthropic-ai/aws-sdk`).

```typescript
const provider = createAnthropicProvider({
  awsRegion: 'us-east-1',
  awsWorkspaceId: 'wrkspc_...', // optional
  apiKey: process.env.ANTHROPIC_AWS_API_KEY,
  agentId: 'agent_01J...',
  environmentId: 'env_01J...',
  durable: cloudflare({ ... }), // optional — API key auth works with EdgeObserver
});
```

## The Provider Interface

Every provider implements this. All downstream code is provider-agnostic.

```typescript
interface Provider {
  readonly provider: string;    // 'openai' | 'anthropic'
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
  turnId: string;
}
```

When `durable` is configured with an edge observer (Cloudflare + webhook), TypeScript narrows `send()` to return `Promise<WebhookSendResult>` instead of `SendResult`. The narrowed `WebhookProvider` also exposes `createWebhookHandler({ secret })`, which inherits `logger` and `onSessionEvents` from provider config.

## Messages

```typescript
enum MessageRole { USER = 'user', ASSISTANT = 'assistant', SYSTEM = 'system' }

interface Message {
  role: MessageRole;
  content: string | ContentPart[];
}

// ContentPart variants:
// { type: 'text', text: string }
// { type: 'image', data: string, mediaType: string }
// { type: 'image-url', url: string }
// { type: 'file', data: string, mediaType: string, name?: string }
```

### Provider differences (Anthropic)

> [!IMPORTANT]
> Anthropic Managed Agent sessions **do not replay assistant/system rows as native input** — history is server-side. Thalamus accepts the same `messages[]` as OpenAI so your code does not branch on provider, but on Anthropic prior `assistant`/`system` rows are folded into a `[Context]` text block on the next user message. Treat this as a **recovery workaround** (dead/expired session), not normal operation.

**Prefer:** live `sessionId` + one new `USER` message.

**Recovery only:** pass saved transcript as `ASSISTANT` + `USER` rows when the session is gone. OpenAI uses native roles; Anthropic gets the packed format.

Use `ASSISTANT` for prior agent chat lines, `SYSTEM` only for extra per-send instructions (agent persona belongs on provider/agent config).

## send() and SendResult

`send()` returns a `SendResult` — a `PromiseLike<Response>` that you can consume in several ways:

```typescript
// Await for final response
const response = await provider.send({ messages });

// Just the text
const text = await provider.send({ messages }).text();

// Get the sessionId early (resolves before the stream finishes)
const result = provider.send({ messages });
const sessionId = await result.sessionId;

// runId is known synchronously — unique per send() invocation
const result = provider.send({ messages });
console.log(result.runId); // e.g. 'a1b2c3d4-...'

// turnId groups sends within one logical user interaction (e.g. message + tool approvals)
console.log(result.turnId); // e.g. 'e5f6g7h8-...'
// Carry it forward on approval resumes:
await provider.send({ sessionId, toolResults, turnId: result.turnId, messages: [] });
```

### IDs

| ID | Scope | Lifecycle | Purpose |
|---|---|---|---|
| `sessionId` | Conversation | Many turns | Provider session identity |
| `turnId` | User interaction | One user message -> final answer (may span multiple `send()` calls for tool approvals) | Business grouping |
| `runId` | Webhook delivery | One `send()` call | Transport dedup/observability |

- **`runId`** — fresh UUID per `send()`. Available synchronously on `SendResult` and in `WebhookSendResult`. Passed in the `onSessionEvents` context object. Echoed in every webhook payload.
- **`turnId`** — stable across approval resumes. Generated automatically on fresh sends, carried forward when you pass `turnId` from a previous `SendResult` in `RequestParams`. Groups a logical user interaction (initial message + subsequent tool approvals) under one ID.

### RequestParams

```typescript
interface RequestParams {
  messages: Message[];
  sessionId?: string;           // continue a conversation
  vaultIds?: string[];          // bind vault credentials
  toolResults?: ToolResult[];   // approval responses or tool outputs
  providerOptions?: Record<string, unknown>; // pass-through to provider SDK
  abortSignal?: AbortSignal;    // cancel the request
  webhookMetadata?: Record<string, string>; // forwarded in webhook payloads
  turnId?: string;              // carry forward from previous SendResult for turn grouping
}
```

### Sequential turns

Messages to the same session are serialized automatically. If you `send()` while a previous turn is still running, it queues and dispatches when the session is ready. `toolResults` bypass the queue (they resolve the current `requires-action` turn). Different sessions don't block each other.

A `status-change: queued` event fires when a message is waiting. In webhook mode, the edge observer manages the queue and sends `queue-ready` webhooks when slots open.

### providerOptions Pass-Through

Forward arbitrary options to the underlying SDK call:

```typescript
await provider.send({
  messages,
  providerOptions: {
    temperature: 0.5,
    max_output_tokens: 4096,
    reasoning: { effort: 'high' },
  },
});
```

## Streaming with Callbacks

Callbacks are attached at **provider creation time** via `onSessionEvents`, not on individual `send()` calls. This is intentional — the same factory is used to re-attach callbacks when recovering durable sessions after a restart.

```typescript
const provider = createOpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4o',
  onSessionEvents: ({ sessionId, turnId, runId }) => ({
    onTextDelta: ({ text }) => pushToClient(sessionId, text),
    onToolUseDone: ({ toolName }) => console.log(`[${runId}] used ${toolName}`),
    onFinish: ({ response }) => saveResponse(sessionId, response),
  }),
});

// When onSessionEvents is set, send() starts consuming immediately —
// callbacks fire even if you never await the result.
provider.send({ messages });
```

The factory receives a `SessionEventContext` object containing:
- `sessionId` — route events to the right client connection
- `turnId` — group events from the same logical user interaction (stable across approval resumes)
- `runId` — correlate callbacks to a specific `send()` invocation (unique per call)
- `metadata` — webhook metadata from the originating `send()` (empty object in streaming mode)

### Async callbacks and sequential dispatch

Callbacks may return `void` or `Promise<void>`. When a callback returns a promise, the SDK **awaits it before dispatching the next event**:

```typescript
onSessionEvents: ({ sessionId, runId }) => ({
  // Sync — instant, no backpressure (ideal for streaming text to a socket)
  onTextDelta: ({ text }) => socket.emit('delta', text),

  // Async — awaited before the next event dispatches (ideal for DB writes)
  onToolUseDone: async ({ toolName, input }) => {
    await db.activities.insertOne({ sessionId, runId, toolName, input });
  },
}),
```

This applies to both streaming mode and webhook mode — same callbacks, same ordering guarantee. Sync callbacks add zero overhead (`await undefined` = one microtick). To fire-and-forget inside a callback, use `void asyncFn()` without returning the promise.

### StreamPart types

| Type | Key fields |
|---|---|
| `text-delta` | `text` |
| `thinking` | `text` |
| `refusal` | `text` |
| `tool-use-start` | `toolName`, `toolUseId`, `source?` |
| `tool-use-delta` | `toolUseId`, `argumentsDelta` |
| `tool-use-done` | `toolName`, `toolUseId`, `input?`, `source?` |
| `tool-use-result` | `toolUseId`, `content` (`ToolResultContent[]`), `isError?`, `source?` |
| `mcp-tools-discovered` | `serverName`, `tools: McpToolDef[]` |
| `status-change` | `status: 'running' \| 'queued' \| 'retrying' \| 'idle'` |
| `stream-start` | `sessionId?` |
| `finish` | `response: Response` |
| `error` | `error: Error` |
| `provider-event` | `provider`, `event`, `data` (escape hatch) |

### StreamCallbacks

One callback per StreamPart type, plus `onPart` which fires for every part before type-specific callbacks:

```typescript
interface StreamCallbacks {
  onPart?: (part: StreamPart) => void;
  onTextDelta?: ...;
  onThinking?: ...;
  onRefusal?: ...;
  onToolUseStart?: ...;
  onToolUseDelta?: ...;
  onToolUseDone?: ...;
  onToolUseResult?: ...;
  onMcpToolsDiscovered?: ...;
  onStatusChange?: ...;
  onStreamStart?: ...;
  onFinish?: ...;
  onError?: ...;
  onProviderEvent?: ...;
}
```

### Response

```typescript
interface Response {
  content: string;
  sessionId?: string;
  finishReason: 'stop' | 'length' | 'error' | 'requires-action' | 'refused' | 'other';
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  actionsRequired?: ActionRequired[];
}
```

## Sessions

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

With a live `sessionId`, send only the new user turn. After session loss, pass transcript in `messages` only as a recovery fallback — see Provider differences above.

## AbortSignal

Pass an `AbortSignal` to cancel long-running agent turns:

```typescript
const controller = new AbortController();

const result = provider.send({
  messages,
  abortSignal: controller.signal,
});

controller.abort();

try {
  await result;
} catch (err) {
  if (err instanceof AbortedError) {
    // err.sessionId is available when known
  }
}
```

## MCP Servers

### OpenAI — configure at provider creation

```typescript
const provider = createOpenAIProvider({
  apiKey: '...',
  model: 'gpt-4o',
  mcpServers: [{
    name: 'github',
    url: 'https://api.githubcopilot.com/mcp/',
    authorization: 'Bearer ghp_xxx',     // optional static auth
    allowedTools: ['search_repos'],      // optional tool filter
    approvalPolicy: 'never',            // 'always' | 'never' | { except: string[] }
  }],
});
```

### Anthropic — MCP servers are configured in the Anthropic console at the environment level.

### Detecting tool source

```typescript
onSessionEvents: ({ sessionId }) => ({
  onToolUseDone: (part) => {
    if (part.source?.type === 'mcp') {
      console.log(`MCP tool from ${part.source.serverName}`);
    } else if (part.source?.type === 'custom') {
      console.log('Custom tool — you handle execution');
    }
  },
  onMcpToolsDiscovered: ({ serverName, tools }) => {
    console.log(`${serverName} offers: ${tools.map(t => t.name)}`);
  },
}),
```

`ToolSource` is `{ type: 'builtin' }`, `{ type: 'custom' }`, or `{ type: 'mcp', serverName }`.

## Vault & Credentials

Vaults manage credentials for MCP server authentication.

- **Anthropic** — proxies to Anthropic's native Vault API (server-side storage).
- **OpenAI** — stored in a `VaultStore` you provide, injected into MCP requests at call time.

```typescript
// OpenAI setup — pass a VaultStore
import { createMemoryVaultStore } from '@novu/thalamus';
const provider = createOpenAIProvider({
  apiKey: '...',
  mcpServers: [{ name: 'github', url: '...' }],
  vaultStore: createMemoryVaultStore(), // in-memory; implement VaultStore for production
});

// Create vault, add credential, use it
const vault = await provider.createVault({ name: 'Alice' });
await vault.add('github', { type: 'bearer', token: 'ghp_xxx' });
const response = await provider.send({
  messages: [...],
  vaultIds: [vault.id],
});

// Credential types
type Credential =
  | { type: 'bearer'; token: string }
  | { type: 'oauth'; accessToken: string; expiresAt?: string; refresh?: OAuthRefreshConfig };

// Vault API
vault.add(name, credential)    // add credential
vault.update(name, credential) // replace credential
vault.remove(name)             // remove credential
vault.list()                   // list credentials (CredentialInfo[], no secrets)
vault.destroy()                // delete vault
```

### Custom VaultStore (production)

Implement the `VaultStore` interface to persist credentials in your database:

```typescript
interface VaultStore {
  createVault(options: VaultOptions): Promise<VaultRecord>;
  getVault(vaultId: string): Promise<VaultRecord | null>;
  updateVaultMetadata(vaultId: string, metadata: Record<string, string>): Promise<void>;
  removeVault(vaultId: string): Promise<void>;
  set(vaultId: string, name: string, credential: Credential): Promise<void>;
  get(vaultId: string, name: string): Promise<StoredCredential | null>;
  getAll(vaultId: string): Promise<StoredCredential[]>;
  remove(vaultId: string, name: string): Promise<void>;
}
```

## Approval Flow (Human-in-the-Loop)

When a tool requires approval, the response finishes with `finishReason: 'requires-action'`:

```typescript
const result = provider.send({ messages });
const response = await result;

if (response.finishReason === 'requires-action') {
  // ActionRequired = { type: 'tool-confirmation' | 'mcp-approval', toolUseId, toolName, input? }
  for (const action of response.actionsRequired!) {
    console.log(`${action.toolName} wants to run with`, action.input);
  }

  // Resume with approval — carry turnId to group under the same logical turn
  const resumed = await provider.send({
    messages: [],
    sessionId: response.sessionId,
    turnId: result.turnId,
    toolResults: response.actionsRequired!.map(a => ({
      toolUseId: a.toolUseId,
      approved: true,  // or false to deny
    })),
  });
}
```

### Sending custom tool results

```typescript
const response = await provider.send({
  messages: [],
  sessionId: previousResponse.sessionId,
  toolResults: [{
    toolUseId: 'call_xyz',
    output: JSON.stringify({ result: 42 }),
    isError: false,
  }],
});
```

## Durable Sessions

Agent sessions can run for minutes. The `durable` option on provider config enables persistence and recovery across connection drops and process restarts.

Two kinds of backends:

### Checkpoint backends (Redis)

The SDK holds the SSE connection in your Node.js process. Events are checkpointed to Redis. On connection drops, it reconnects from the last checkpoint with up to 3 retries. On process restart, active sessions resume automatically.

Requires `onSessionEvents` to be set so callbacks can be re-attached on recovery.

```typescript
import { redis } from '@novu/thalamus/durable';
import { createOpenAIProvider } from '@novu/thalamus';
import Redis from 'ioredis';

const provider = createOpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4o',
  durable: redis(new Redis()),
  onSessionEvents: ({ sessionId, runId }) => ({
    onTextDelta: ({ text }) => pushToClient(sessionId, text),
    onFinish: ({ response }) => saveResponse(sessionId, response),
  }),
});

// Custom hash key
const backend = redis(redisClient, { key: 'myapp:sessions' });
```

### Edge observer (Cloudflare)

Instead of holding the SSE connection in your Node.js process, offload it to a Cloudflare Worker. Your app just needs a webhook endpoint — no SSE connections, no reconnection logic.

```typescript
import { cloudflare } from '@novu/thalamus/durable';
import { createWebhookHandler } from '@novu/thalamus/webhook';

// Provider setup — send() returns sessionId (not Response) in webhook mode
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
const { sessionId, runId, turnId } = await provider.send({
  messages: [{ role: MessageRole.USER, content: 'Hello' }],
  webhookMetadata: { userId: 'u_123' }, // forwarded in webhook payloads
});
```

### Webhook handler

Receives events from the Cloudflare edge observer. HMAC-verified.

```typescript
const handler = createWebhookHandler({
  secret: process.env.WEBHOOK_SECRET,
  logger: adaptPinoLogger(pino), // optional — same adapter as provider
  onSessionEvents: ({ sessionId, turnId, runId, metadata }) => ({
    onPart(part) {
      switch (part.type) {
        case 'text-delta':
          pushToClient(sessionId, part.text);
          break;
        case 'finish':
          saveResponse(sessionId, part.response);
          break;
      }
    },
  }),
});

// Or bind to the provider (inherits logger + onSessionEvents)
const handler = provider.createWebhookHandler({
  secret: process.env.WEBHOOK_SECRET,
});

// Express / Node http
app.post('/webhook', (req, res) => handler.express(req, res));

// Web standard Request/Response (Cloudflare Workers, Bun, Deno, Next.js)
export default { fetch: (req) => handler.handle(req) };
```

Note: the webhook `onSessionEvents` factory receives a `SessionEventContext` object with `sessionId`, `turnId`, `runId`, and `metadata`. The `metadata` contains the `webhookMetadata` you passed in `send()`. Session and run IDs are also exposed in the request headers: `X-Thalamus-Session-Id`, `X-Thalamus-Run-Id`.

Use standalone `createWebhookHandler` when one webhook endpoint serves many providers (e.g. Novu). Use `provider.createWebhookHandler` for single-provider apps.

### Sequential turns in webhook mode

The edge observer queues messages per session. When you `send()` while a turn is active, the observer stores the request in SQLite and returns `{ status: "queued" }`. When the active turn completes, it sends a `queue-ready` webhook. The `WebhookHandler` intercepts it and calls `provider.dispatchQueued()` to dispatch via SDK.

This is automatic with `provider.createWebhookHandler()`. For multi-provider setups using standalone `createWebhookHandler()`, pass `onQueueReady`:

```typescript
const handler = createWebhookHandler({
  secret,
  onSessionEvents: (ctx) => handlers(ctx),
  onQueueReady: async ({ sessionId, runId, turnId, request }) => {
    const provider = await resolveProvider(request.webhookMetadata);
    await provider.dispatchQueued(sessionId, runId, turnId, request);
  },
});
```

Key types for the edge observer interface:

```typescript
interface EdgeObserver {
  enqueue(params: EdgeEnqueueParams): Promise<{ status: "active" | "queued" }>;
  observe(params: EdgeObserveParams): Promise<void>;
  stop(sessionId: string): Promise<void>;
}

interface WebhookProvider {
  // ...existing methods...
  dispatchQueued(sessionId: string, runId: string, turnId: string,
                 request: SerializedRequestParams): Promise<void>;
}
```

### Custom durability backend

Implement `DurabilityBackend` for checkpoint-based durability with any storage:

```typescript
interface DurabilityBackend {
  save(checkpoint: SessionCheckpoint): Promise<void>;
  remove(sessionId: string): Promise<void>;
  getActive(): Promise<SessionCheckpoint[]>;
}
```

## Lifecycle Logging

Opt-in structured logging for the durable pipeline (observe → dispatch → webhook → callbacks). **Default is silent** — no behavior change without opt-in.

SDK logs plumbing only (observe registration, dispatch, webhook ingress). Business events stay in `onSessionEvents` / `onPart`.

### Provider config

```typescript
import { adaptPinoLogger } from '@novu/thalamus';

const log = adaptPinoLogger(pino); // flips (msg, ctx) → Pino's (ctx, msg)

const provider = thalamus.anthropic({
  agentId,
  environmentId,
  apiKey,
  durable: cloudflare({ url, webhook }),
  logger: log,              // false | 'silent' | 'debug' | custom adapter
  onSessionEvents: (ctx) => ({ ... }),
});
```

| `logger` value | Behavior |
|---|---|
| omitted / `false` / `"silent"` | No SDK logs |
| `"debug"` | Built-in console adapter (`[thalamus] stage { ctx }`) |
| custom / partial | Used as-is; missing methods no-op |

Helpers exported from `@novu/thalamus`: `resolveLogger`, `silentLogger`, `createConsoleLogger`, `adaptPinoLogger`, `logErrorMessage`.

### Webhook handler

Pass the same adapter on standalone handlers (required when webhook is a singleton separate from provider creation):

```typescript
const handler = createWebhookHandler({
  secret,
  logger: log,
  onSessionEvents: (ctx) => ({ ... }),
});
```

Or use `provider.createWebhookHandler({ secret })` to inherit provider `logger` and `onSessionEvents`.

### Log context

Every log includes a `stage` key plus correlation fields when available:

```typescript
type LogContext = {
  stage: string;
  provider?: 'anthropic' | 'openai';
  sessionId?: string;
  runId?: string;
  turnId?: string;
  sequence?: number;
  eventType?: string;
  mode?: 'webhook' | 'stream';
  durationMs?: number;
  error?: string;
};
```

### Stage vocabulary

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
| `webhook.callback.failed` | error | `onSessionEvents` callback threw |

`cloudflare()` has no logger — provider logs the observe lifecycle.

## Cloudflare Worker Deployment

The companion edge observer worker lives in `cloudflare-worker/`. It uses the Cloudflare Agents SDK with a Durable Object per session that:

- Opens the SSE connection to the AI provider
- Persists every event to SQLite
- Delivers events to your webhook with at-least-once delivery
- Retries with exponential backoff, hibernates between retries

### Deploy

```bash
cd cloudflare-worker
pnpm install
npx wrangler secret put API_KEY    # set the auth key
npx wrangler deploy
```

### Local development

```bash
cd cloudflare-worker
pnpm install
npx wrangler dev
```

The worker depends on `@novu/thalamus` as a workspace package (linked via `pnpm-workspace.yaml`). Changes to the main package are immediately reflected without publishing.

### API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/observe` | Start observing a session |
| `DELETE` | `/observe/:sessionId` | Stop observation (pending events still deliver) |
| `GET` | `/health` | Health check |

These endpoints are called automatically by the SDK when using `cloudflare()` as a durable backend — you don't call them directly.

## Error Handling

All errors extend `ThalamusError` with `provider` and `isRetryable` fields.

| Error class | Retryable | When |
|---|---|---|
| `ProviderAuthError` | No | Invalid API key / unauthorized |
| `ProviderRateLimitError` | Yes | Rate limited (has `retryAfterMs?`) |
| `ProviderUnavailableError` | Yes | Provider temporarily down |
| `ProviderResponseError` | No | Invalid response from provider |
| `SessionExpiredError` | Yes | Session expired (has `sessionId`) |
| `AbortedError` | No | Request cancelled via `AbortSignal` (has `sessionId?`) |
| `VaultNotFoundError` | No | Vault doesn't exist (has `vaultId`) |
| `CredentialExpiredError` | No | Credential expired, no refresh config |
| `McpServerError` | 5xx only | MCP server error (has `serverName`, `statusCode?`) |

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

## Package Subpaths

| Subpath | Contents |
|---|---|
| `@novu/thalamus` | Core types, errors, `thalamus` factory, `createMemoryVaultStore`, logger helpers, both providers |
| `@novu/thalamus/anthropic` | `createAnthropicProvider` |
| `@novu/thalamus/openai` | `createOpenAIProvider` |
| `@novu/thalamus/vault` | Vault types and `VaultStore` interface |
| `@novu/thalamus/durable` | `redis()`, `cloudflare()`, `DurabilityBackend`, `EdgeObserver` |
| `@novu/thalamus/webhook` | `createWebhookHandler`, `createProviderWebhookHandler` — HMAC-verified webhook receiver |

## Key Design Notes

- `SendResult` is `PromiseLike<Response>` — you can `await` it directly or call `.text()` / `.sessionId` / `.runId` / `.turnId`.
- `runId` is generated synchronously per `send()` call (UUID). Available on `SendResult.runId`, in `WebhookSendResult`, passed in the `onSessionEvents` context, and echoed in every webhook payload + header (`X-Thalamus-Run-Id`).
- `turnId` groups multiple `send()` calls within one logical user interaction (e.g. initial message + tool approval resumes). Generated automatically on fresh sends; carried forward when you pass `turnId` from a previous result in `RequestParams`.
- `onSessionEvents` factory receives a `SessionEventContext` object (`{ sessionId, turnId, runId, metadata }`) — extensible without breaking changes.
- Callbacks are set at **provider creation** via `onSessionEvents`, not per `send()` call. This ensures consistent callback re-attachment for durable session recovery.
- When `onSessionEvents` is set, `send()` auto-starts consumption — callbacks fire even without `await`.
- OpenAI sessions use the Conversations API when available; falls back to `previous_response_id` for Bedrock.
- Anthropic sessions are server-managed; `createSession()` creates a real session, `endSession()` is a no-op. Prior assistant rows in `messages` are packed into `[Context]` text on the next user turn — a recovery workaround, not native replay.
- `ToolSource` on tool events tells you origin: `{ type: 'builtin' }`, `{ type: 'custom' }`, or `{ type: 'mcp', serverName }`.
- Zero runtime dependencies; only optional peer deps for provider SDKs.
- `logger?` on provider config enables opt-in lifecycle logging (default silent). Use `adaptPinoLogger(pino)` for Pino; pass the same adapter to standalone `createWebhookHandler` when webhook is wired separately.
