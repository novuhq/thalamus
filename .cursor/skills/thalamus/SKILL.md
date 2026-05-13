---
name: thalamus
description: "Build with @novu/thalamus, a provider-agnostic runtime for managed AI agents. Use when code imports @novu/thalamus, creates AI providers (OpenAI, Anthropic), streams agent responses, manages sessions, configures MCP servers, handles vaults/credentials, or implements approval flows."
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

// Errors
import { ThalamusError, ProviderRateLimitError, ProviderAuthError } from '@novu/thalamus';
```

## Creating Providers

### OpenAI (direct)

```typescript
const provider = createOpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4o',             // optional, defaults to 'gpt-4o'
  instructions: '...',          // optional system instructions
  promptId: '...',              // optional, sets runtimeId
  mcpServers: [...],            // optional MCP server configs
  vaultStore: createMemoryVaultStore(), // optional, required for vault ops
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
});
```

### Anthropic via AWS

```typescript
const provider = createAnthropicProvider({
  awsRegion: 'us-east-1',
  awsWorkspaceId: '...',       // optional
  agentId: 'agent_01J...',
  environmentId: 'env_01J...',
});
```

## The Provider Interface

Every provider implements this. All downstream code is provider-agnostic.

```typescript
interface Provider {
  readonly provider: string;    // 'openai' | 'anthropic'
  readonly runtimeId: string;
  stream(params: RequestParams, callbacks?: StreamCallbacks): StreamResult;
  createVault(options: VaultOptions): Promise<Vault>;
  getVault(vaultId: string): Promise<Vault>;
  createSession(options?: SessionOptions): Promise<string>;
  endSession(sessionId: string): Promise<void>;
}
```

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

## Streaming

`stream()` returns a `StreamResult` that is `PromiseLike<Response>`.

```typescript
// Await for final response
const response = await provider.stream({ messages });

// Stream with callbacks
const response = await provider.stream({ messages }, {
  onTextDelta: ({ text }) => process.stdout.write(text),
  onToolUseDone: ({ toolName, input }) => console.log(toolName, input),
  onFinish: ({ response }) => console.log(response.usage),
});

// Just get the text
const text = await provider.stream({ messages }).text();
```

### RequestParams

```typescript
interface RequestParams {
  messages: Message[];
  sessionId?: string;           // continue a conversation
  vaultIds?: string[];          // bind vault credentials
  toolResults?: ToolResult[];   // approval responses or tool outputs
  providerOptions?: Record<string, unknown>; // pass-through to provider SDK
}
```

### StreamPart types

| Type | Key fields |
|---|---|
| `text-delta` | `text` |
| `thinking` | `text` |
| `refusal` | `text` |
| `tool-use-start` | `toolName`, `toolUseId`, `source?` |
| `tool-use-delta` | `toolUseId`, `argumentsDelta` |
| `tool-use-done` | `toolName`, `toolUseId`, `input?`, `source?` |
| `tool-use-result` | `toolUseId`, `output?`, `source?` |
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
const first = await provider.stream({
  messages: [{ role: MessageRole.USER, content: 'Remember: my name is Alice' }],
});

const second = await provider.stream({
  sessionId: first.sessionId,
  messages: [{ role: MessageRole.USER, content: 'What is my name?' }],
});
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

### Detecting MCP vs builtin tools

```typescript
provider.stream({ messages }, {
  onToolUseDone: (part) => {
    if (part.source?.type === 'mcp') {
      console.log(`MCP tool from ${part.source.serverName}`);
    }
  },
  onMcpToolsDiscovered: ({ serverName, tools }) => {
    console.log(`${serverName} offers: ${tools.map(t => t.name)}`);
  },
});
```

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
const response = await provider.stream({
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

When a tool requires approval, the stream finishes with `finishReason: 'requires-action'`:

```typescript
const response = await provider.stream({ messages });

if (response.finishReason === 'requires-action') {
  // ActionRequired = { type: 'tool-confirmation' | 'mcp-approval', toolUseId, toolName, input? }
  for (const action of response.actionsRequired!) {
    console.log(`${action.toolName} wants to run with`, action.input);
  }

  // Resume with approval
  const resumed = await provider.stream({
    messages: [],
    sessionId: response.sessionId,
    toolResults: response.actionsRequired!.map(a => ({
      toolUseId: a.toolUseId,
      approved: true,  // or false to deny
    })),
  });
}
```

### Sending custom tool results

```typescript
const response = await provider.stream({
  messages: [],
  sessionId: previousResponse.sessionId,
  toolResults: [{
    toolUseId: 'call_xyz',
    output: JSON.stringify({ result: 42 }),
    isError: false,
  }],
});
```

## Error Handling

All errors extend `ThalamusError` with `provider` and `isRetryable` fields.

| Error class | Retryable | When |
|---|---|---|
| `ProviderAuthError` | No | Invalid API key / unauthorized |
| `ProviderRateLimitError` | Yes | Rate limited (has `retryAfterMs?`) |
| `ProviderUnavailableError` | Yes | Provider temporarily down |
| `ProviderResponseError` | No | Invalid response from provider |
| `SessionExpiredError` | Yes | Session expired (has `sessionId`) |
| `VaultNotFoundError` | No | Vault doesn't exist (has `vaultId`) |
| `CredentialExpiredError` | No | Credential expired, no refresh config |
| `McpServerError` | 5xx only | MCP server error (has `serverName`, `statusCode?`) |

```typescript
import { ThalamusError, ProviderRateLimitError } from '@novu/thalamus';

try {
  await provider.stream({ messages });
} catch (err) {
  if (err instanceof ProviderRateLimitError) {
    await sleep(err.retryAfterMs ?? 5000);
  } else if (err instanceof ThalamusError && err.isRetryable) {
    // generic retry
  }
}
```

## providerOptions Pass-Through

Forward arbitrary options to the underlying SDK call:

```typescript
await provider.stream({
  messages,
  providerOptions: {
    temperature: 0.5,
    max_output_tokens: 4096,
    reasoning: { effort: 'high' },
  },
});
```

## Key Design Notes

- `StreamResult` is `PromiseLike<Response>` — you can `await` it directly or call `.text()`.
- `collectStream()` is deprecated — just `await` the stream result instead.
- OpenAI sessions use the Conversations API when available; falls back to `previous_response_id` for Bedrock.
- Anthropic sessions are server-managed; `createSession()` creates a real session, `endSession()` is a no-op.
- `ToolSource` on tool events tells you origin: `{ type: 'builtin' }`, `{ type: 'custom' }`, or `{ type: 'mcp', serverName }`.
