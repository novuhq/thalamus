# @novu/thalamus

Provider-agnostic runtime for managed AI agents. One interface, same messages in, same streaming events out — regardless of which provider runs the agent.

## Why

Every AI provider has its own session model, event shapes, and streaming format. Supporting multiple providers means writing separate codepaths for each.

Thalamus gives you a single `Provider` interface that normalizes messages, streaming events, and session continuity so your application code stays provider-agnostic.

## Features

- **Unified `Provider` interface** — `send()` and `stream()` across all providers
- **Normalized streaming** — common `StreamPart` events for text, tool use, thinking, errors
- **MCP server support** — configure remote MCP tools, track tool sources (builtin vs MCP)
- **Vault & credential management** — store and inject credentials for MCP server authentication
- **Approval flow** — human-in-the-loop pattern for tool confirmation
- **Session continuity** — pass `sessionId` to resume conversations with any provider
- **Tree-shakeable** — subpath exports per provider, install only what you use
- **TypeScript-first** — full type coverage, dual ESM/CJS output
- **Zero runtime dependencies** — only peer deps for the provider SDKs you need

## Supported Providers

| Provider | Subpath | Peer dependency |
|---|---|---|
| Anthropic Managed Agents | `@novu/thalamus/anthropic` | `@anthropic-ai/sdk` |
| Anthropic via AWS | `@novu/thalamus/anthropic` | `@anthropic-ai/aws-sdk` |
| OpenAI Responses API | `@novu/thalamus/openai` | `openai` |
| OpenAI via AWS Bedrock Mantle | `@novu/thalamus/openai` | `openai` (+ `@smithy/signature-v4` for SigV4) |

## Install

```bash
npm install @novu/thalamus
```

Then install the peer dependency for your provider:

```bash
npm install @anthropic-ai/sdk   # or openai, etc.
```

## Quick Start

Every provider returns the same `Provider` interface — creation is the only part that differs:

```typescript
import { createAnthropicProvider, MessageRole } from '@novu/thalamus';

const provider = createAnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY,
  agentId: 'agent_01J...',
  environmentId: 'env_01J...',
});

// Streaming
const result = await provider.stream({
  messages: [{ role: MessageRole.USER, content: 'What can you help me with?' }],
});

for await (const part of result.stream) {
  if (part.type === 'text-delta') {
    process.stdout.write(part.text);
  }
}

// Non-streaming
const response = await provider.send({
  messages: [{ role: MessageRole.USER, content: 'Hello' }],
});

console.log(response.content);
console.log(response.sessionId); // pass back to continue the conversation
```

Swap in any other provider — the rest of the code stays identical:

```typescript
import { createOpenAIProvider } from '@novu/thalamus';

const provider = createOpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4o',
});
```

## Key Concepts

### Provider

The core abstraction. Every provider implements:

```typescript
interface Provider {
  readonly provider: string;
  readonly runtimeId: string;
  send(params: RequestParams): Promise<Response>;
  stream(params: RequestParams): Promise<StreamResult>;
  createVault(options: VaultOptions): Promise<Vault>;
  getVault(vaultId: string): Promise<Vault>;
  createSession(options?: SessionOptions): Promise<string>;
  endSession(sessionId: string): Promise<void>;
}
```

You can also use the convenience entry point:

```typescript
import { thalamus } from '@novu/thalamus';

const provider = thalamus.anthropic({ /* config */ });
// or
const provider = thalamus.openai({ /* config */ });
```

### Messages

Normalized message format supporting text and multimodal content:

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

### Streaming

`stream()` returns a `StreamResult` with two complementary interfaces:

```typescript
interface StreamResult {
  stream: AsyncIterable<StreamPart>;  // incremental events
  response: Promise<Response>;        // final rolled-up result
}
```

Both resolve from the same underlying generator — consuming either one drives the other. Stream events include:

| Event | Description |
|---|---|
| `text-delta` | Incremental text output |
| `thinking` | Model reasoning/thinking content |
| `refusal` | Model refused to respond |
| `tool-use-start` | Tool call initiated |
| `tool-use-delta` | Streaming tool call arguments |
| `tool-use-done` | Tool call completed with parsed input |
| `tool-use-result` | Tool execution result |
| `status-change` | Agent status (`running`, `queued`, `retrying`, `idle`) |
| `stream-start` | Stream opened, includes `sessionId` |
| `finish` | Stream complete, includes final `Response` |
| `error` | Error occurred |
| `provider-event` | Unmapped provider-specific event (escape hatch) |

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

How `sessionId` maps to the underlying provider mechanism is handled internally.

### MCP Servers

OpenAI supports configuring remote MCP servers directly:

```typescript
const provider = createOpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4o',
  mcpServers: [
    { name: 'github', url: 'https://api.githubcopilot.com/mcp/', approvalPolicy: 'never' },
  ],
});
```

Anthropic MCP servers are configured in the Anthropic console at the environment level.

Tool events include a `source` field to distinguish builtin tools from MCP tools:

```typescript
for await (const part of result.stream) {
  if (part.type === 'tool-use-done') {
    console.log(part.source); // { type: 'builtin' } or { type: 'mcp', serverName: 'github' }
  }
  if (part.type === 'mcp-tools-discovered') {
    console.log(part.serverName, part.tools); // tools available on this MCP server
  }
}
```

### Vault & Credentials

Vaults manage credentials for MCP server authentication. The API is the same regardless of provider — how credentials are stored differs internally:

- **Anthropic** — calls proxy to Anthropic's native Vault API. Credentials are stored and resolved server-side by Anthropic.
- **OpenAI** — credentials are stored in a `VaultStore` you provide and injected into MCP tool requests at call time.

```typescript
// Create a vault
const vault = await provider.createVault({ name: 'Alice' });

// Add a credential — name matches the MCP server name
await vault.add('github', { type: 'bearer', token: 'ghp_xxx' });

// Stream with vault credentials injected
await provider.stream({
  messages: [{ role: MessageRole.USER, content: 'List my GitHub repos' }],
  vaultIds: [vault.id],
});

// Manage credentials
await vault.list();                  // list credentials (without secrets)
await vault.update('github', cred);  // replace a credential
await vault.remove('github');        // remove a credential
await vault.destroy();               // delete the vault entirely
```

**OpenAI setup** — pass a `VaultStore` when creating the provider:

```typescript
import { createMemoryVaultStore } from '@novu/thalamus';

const provider = createOpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY,
  mcpServers: [{ name: 'github', url: 'https://api.githubcopilot.com/mcp/' }],
  vaultStore: createMemoryVaultStore(),
});
```

**Anthropic setup** — no extra configuration needed. Vaults are managed via the Anthropic API:

```typescript
const provider = createAnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY,
  agentId: 'agent_01J...',
  environmentId: 'env_01J...',
});
```

`createMemoryVaultStore()` is included for development and testing. For production, implement the `VaultStore` interface with your database.

### Approval Flow

When an MCP tool requires approval, the stream ends with `finishReason: 'requires-action'`:

```typescript
const result = await provider.stream({ messages: [...] });
const response = await result.response;

if (response.finishReason === 'requires-action') {
  for (const action of response.actionsRequired) {
    console.log(`${action.toolName} wants to run with`, action.input);
  }

  // Send approval back
  await provider.stream({
    messages: [],
    sessionId: response.sessionId,
    toolResults: response.actionsRequired.map(a => ({
      toolUseId: a.toolUseId,
      approved: true, // or false to deny
    })),
  });
}
```

## Error Handling

All errors extend `ThalamusError` with `provider` and `isRetryable` fields:

| Error | Retryable | When |
|---|---|---|
| `ProviderAuthError` | No | Invalid API key or unauthorized |
| `ProviderRateLimitError` | Yes | Rate limit exceeded (includes optional `retryAfterMs`) |
| `ProviderUnavailableError` | Yes | Provider temporarily unavailable |
| `ProviderResponseError` | No | Invalid response from provider |
| `SessionExpiredError` | Yes | Session expired or archived (includes `sessionId`) |
| `VaultNotFoundError` | No | Vault does not exist (includes `vaultId`) |
| `CredentialExpiredError` | No | Credential expired with no refresh config |
| `McpServerError` | 5xx only | MCP server returned an error (includes `serverName`, `statusCode`) |

```typescript
import { ThalamusError, ProviderRateLimitError } from '@novu/thalamus';

try {
  await provider.send({ messages });
} catch (err) {
  if (err instanceof ProviderRateLimitError) {
    await sleep(err.retryAfterMs ?? 5000);
  } else if (err instanceof ThalamusError && err.isRetryable) {
    // generic retry
  }
}
```

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
