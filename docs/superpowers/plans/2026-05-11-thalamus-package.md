# @novu/thalamus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `@novu/thalamus` npm package — a provider-agnostic wrapper for Claude Managed Agents and OpenAI Responses API, each with optional AWS authentication, with a streaming-first interface.

**Architecture:** Stateless turn-based library. Each provider wraps its native SDK behind a common `Provider` interface (`stream()` + `send()`). Types grow incrementally — only defined when a provider actually needs them. Providers are tree-shakable via subpath exports. AWS auth variants are built into each provider — not separate providers — because the API surface is identical, only authentication differs.

**Tech Stack:** TypeScript (ES2022), tsup (dual CJS+ESM), vitest, Biome, pnpm. CI/CD and Changesets are out of scope — handled separately after the package is complete.

**Approach:** One provider per phase. After Phase 2 you have a working `thalamus.anthropic()` (with optional AWS auth via Claude Platform on AWS). After Phase 3 you also have `thalamus.openai()` (with optional AWS auth via Bedrock's OpenAI-compatible endpoint). Types expand only as each new provider requires them — you see *why* each type exists.

**Out of scope:** Novu monorepo integration lives in a separate plan against the novu repo. AWS Bedrock Agents (AWS's own agent orchestration service using `InvokeAgentCommand`) is out of scope — it's a fundamentally different product category from managed AI agents and adds limited value as a wrapper.

---

## File Structure (built up progressively)

```
src/
  index.ts                 # grows each phase
  types.ts                 # grows each phase — only what exists is defined
  errors.ts                # grows each phase
  stream-utils.ts          # collectStream() in Phase 2, mapStream() in Phase 4
  anthropic/
    index.ts
    anthropic.provider.ts
    anthropic.transformer.ts
  openai/                  # added in Phase 3
    index.ts
    openai.provider.ts
    openai.transformer.ts

__tests__/
  anthropic/
    anthropic.transformer.test.ts
    anthropic.provider.test.ts
  openai/                  # added in Phase 3
  smoke.test.ts            # added in Phase 4
```

> **Note:** No `<provider>.types.ts` files. Provider-specific types are imported directly from vendor SDKs (peer dependencies). This eliminates type duplication and ensures compile-time safety when SDKs update.

---

## Phase 1: Repo Bootstrap

**Goal:** `pnpm build` and `pnpm test` work. Nothing meaningful yet — just plumbing.

### Task 1: Create all config files and install deps

**Files:**

- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsup.config.ts`
- Create: `vitest.config.ts`
- Create: `biome.json`
- **Step 1: Create package.json**

```json
{
  "name": "@novu/thalamus",
  "version": "0.1.0",
  "description": "Provider-agnostic managed AI agent runtime for Novu",
  "type": "module",
  "exports": {
    ".": {
      "import": "./dist/index.mjs",
      "require": "./dist/index.cjs",
      "types": "./dist/index.d.ts"
    },
    "./anthropic": {
      "import": "./dist/anthropic/index.mjs",
      "require": "./dist/anthropic/index.cjs",
      "types": "./dist/anthropic/index.d.ts"
    },
    "./openai": {
      "import": "./dist/openai/index.mjs",
      "require": "./dist/openai/index.cjs",
      "types": "./dist/openai/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "biome check .",
    "format": "biome format --write .",
    "typecheck": "tsc --noEmit"
  },
  "peerDependencies": {
    "@anthropic-ai/sdk": ">=0.86",
    "@anthropic-ai/aws-sdk": ">=0.86",
    "openai": ">=4.87"
  },
  "peerDependenciesMeta": {
    "@anthropic-ai/sdk": { "optional": true },
    "@anthropic-ai/aws-sdk": { "optional": true },
    "openai": { "optional": true }
  },
  "devDependencies": {
    "@anthropic-ai/sdk": "latest",
    "@anthropic-ai/aws-sdk": "latest",
    "openai": "latest",
    "@biomejs/biome": "latest",
    "tsup": "latest",
    "typescript": "latest",
    "vitest": "latest"
  }
}
```

- **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src",
    "lib": ["ES2022"],
    "useDefineForClassFields": true
  },
  "include": ["src"],
  "exclude": ["dist", "__tests__", "node_modules"]
}
```

- **Step 3: Create tsup.config.ts**

```typescript
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'anthropic/index': 'src/anthropic/index.ts',
    'openai/index': 'src/openai/index.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
});
```

- **Step 4: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { globals: true },
});
```

- **Step 5: Create biome.json**

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.0/schema.json",
  "organizeImports": { "enabled": true },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "suspicious": { "noExplicitAny": "off" }
    }
  },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2 }
}
```

- **Step 6: Install dependencies**

Run: `pnpm install`
Expected: `node_modules/` populated, lockfile created, no errors

- **Step 7: Create stub entry points (tsup needs these to build)**

`src/index.ts`, `src/anthropic/index.ts`, `src/openai/index.ts` — all three:

```typescript
export {};
```

- **Step 8: Verify build works**

Run: `pnpm build`
Expected: `dist/` created with `.mjs`, `.cjs`, `.d.ts` for all three entry points. No errors.

- **Step 9: Commit**

```bash
git add -A
git commit -m "chore: initialize @novu/thalamus package with toolchain"
```

---

## Phase 2: Anthropic Provider (complete, end-to-end)

**Goal:** `thalamus.anthropic({ apiKey, agentId, environmentId }).stream({ messages })` works — with optional AWS auth via Claude Platform on AWS. This phase defines the minimal shared types needed — you'll see exactly why each one exists.

**What you'll understand after this phase:**

- The `Provider` interface and why `stream()` returns `{ stream, response }` instead of just a stream
- How `collectStream()` makes streaming providers work as request/response via `send()`
- How a transformer isolates the format-conversion logic so it's independently testable
- The Anthropic session lifecycle: create → open SSE stream → send user event → iterate events → break on idle
- How AWS auth is a constructor-level concern — `AnthropicAws` extends `Anthropic`, so the rest of the provider is identical

**How the Anthropic Managed Agents API works** (SDK beta header `managed-agents-2026-04-01` is set automatically):

1. `client.beta.sessions.create({ agent: agentId, environment_id: environmentId })` → `{ id: 'sess_xxx' }`
2. Open the SSE stream **before** sending the message (avoids a race condition): `client.beta.sessions.events.stream(sessionId)`
3. Send the user turn: `client.beta.sessions.events.send(sessionId, { events: [{ type: 'user.message', content: [...] }] })`
4. Iterate events until `session.status_idle` (turn complete) or `session.error`
5. Archive when conversation is done: `client.beta.sessions.archive(sessionId)`

`**sessionId`** maps to the Anthropic session ID. Absent = create new session. Present = resume existing session.

### Task 1: Define minimal shared types

**Files:**

- Create: `src/types.ts`
- Create: `src/errors.ts`
- Create: `src/stream-utils.ts`

These are the *only* shared abstractions Phase 2 needs. Notice what's NOT here yet: no `history`, no `actionsRequired`, no `provider-event` — those come when a provider actually needs them.

- **Step 1: Create src/types.ts**

```typescript
export enum MessageRole {
  USER = 'user',
  ASSISTANT = 'assistant',
  SYSTEM = 'system',
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mediaType: string }
  | { type: 'image-url'; url: string }
  | { type: 'file'; data: string; mediaType: string; name?: string };

export interface Message {
  role: MessageRole;
  content: string | ContentPart[];
}

export interface RequestParams {
  message: Message;
  sessionId?: string;
  history?: Message[];
  providerOptions?: Record<string, unknown>;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface Response {
  content: string;
  sessionId?: string;
  finishReason: 'stop' | 'length' | 'error' | 'requires-action' | 'other';
  usage?: Usage;
}

export type StreamPart =
  | { type: 'text-delta'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool-use-start'; toolName: string; toolUseId: string; input?: Record<string, unknown> }
  | { type: 'tool-use-result'; toolUseId: string; output?: string }
  | { type: 'stream-start'; sessionId?: string }
  | { type: 'finish'; response: Response }
  | { type: 'error'; error: Error };

export interface StreamResult {
  stream: AsyncIterable<StreamPart>;
  response: Promise<Response>;
}

export interface Provider {
  readonly provider: string;
  readonly runtimeId: string;
  send(params: RequestParams): Promise<Response>;
  stream(params: RequestParams): Promise<StreamResult>;
  endSession?(sessionId: string): Promise<void>;
  validate?(): Promise<boolean>;
}

export const ANTHROPIC = 'anthropic' as const;
// OPENAI constant added in Phase 3
```

- **Step 2: Create src/errors.ts** (minimal — just the base class for now)

Full error hierarchy (ProviderAuthError etc.) added in Phase 3 when OpenAI needs distinct error types.

```typescript
export class ThalamusError extends Error {
  readonly provider: string;
  readonly isRetryable: boolean;
  override readonly cause?: unknown;

  constructor(
    message: string,
    options: { provider: string; isRetryable: boolean; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = 'ThalamusError';
    this.provider = options.provider;
    this.isRetryable = options.isRetryable;
    this.cause = options.cause;
  }
}
```

- **Step 3: Create src/stream-utils.ts** (`mapStream` added in Phase 5 when needed)

```typescript
import type { Response, StreamResult } from './types.js';

export async function collectStream(
  result: StreamResult,
): Promise<Response> {
  for await (const _part of result.stream) {
    // consume the stream so the generator runs to completion
  }
  return result.response;
}
```

### Task 2: ~~Create Anthropic-specific types~~ (REMOVED)

**Decision:** Provider-specific types are imported directly from the vendor SDK (`@anthropic-ai/sdk/resources/beta/sessions`) rather than redefined locally. Since the SDK is already a peer dependency, re-exporting or duplicating its types adds indirection without safety. Importing directly means TypeScript catches SDK breaking changes at compile time.

Each provider file imports the SDK types it needs inline. No `<provider>.types.ts` file is needed.

### Task 3: Write failing transformer tests, then implement

**Files:**

- Create: `__tests__/anthropic/anthropic.transformer.test.ts`
- Create: `src/anthropic/anthropic.transformer.ts`

The transformer's job: convert `Message[]` → Anthropic content blocks. Tested independently of any HTTP call.

- **Step 1: Write transformer tests**

```typescript
// __tests__/anthropic/anthropic.transformer.test.ts
import { describe, expect, it } from 'vitest';
import { toContentBlocks } from '../../src/anthropic/anthropic.transformer.js';

describe('toContentBlocks', () => {
  it('converts a string to a single text block', () => {
    expect(toContentBlocks('Hello!')).toEqual([
      { type: 'text', text: 'Hello!' },
    ]);
  });

  it('converts a text content part', () => {
    expect(toContentBlocks([{ type: 'text', text: 'Hello!' }])).toEqual([
      { type: 'text', text: 'Hello!' },
    ]);
  });

  it('converts base64 image content parts', () => {
    expect(toContentBlocks([{ type: 'image', data: 'abc123', mediaType: 'image/png' }])).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
    ]);
  });

  it('converts image-url content parts', () => {
    expect(toContentBlocks([{ type: 'image-url', url: 'https://example.com/img.png' }])).toEqual([
      { type: 'image', source: { type: 'url', url: 'https://example.com/img.png' } },
    ]);
  });

  it('converts a file content part to a document block', () => {
    expect(toContentBlocks([{ type: 'file', data: 'cGRm', mediaType: 'application/pdf', name: 'report.pdf' }])).toEqual([
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'cGRm' }, title: 'report.pdf' },
    ]);
  });

  it('sets document title to null when file has no name', () => {
    const result = toContentBlocks([{ type: 'file', data: 'dGV4dA==', mediaType: 'text/plain' }]);
    expect(result[0]).toMatchObject({ type: 'document', title: null });
  });

  it('converts mixed content parts in order', () => {
    const result = toContentBlocks([
      { type: 'text', text: 'Look at this:' },
      { type: 'image', data: 'abc', mediaType: 'image/jpeg' },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ type: 'text' });
    expect(result[1]).toMatchObject({ type: 'image' });
  });
});
```

- **Step 2: Run tests — expect FAIL**

Run: `pnpm test __tests__/anthropic/`
Expected: `FAIL — Cannot find module '../../src/anthropic/anthropic.transformer.js'`

- **Step 3: Create src/anthropic/anthropic.transformer.ts**

```typescript
import type {
  BetaManagedAgentsTextBlock,
  BetaManagedAgentsImageBlock,
  BetaManagedAgentsDocumentBlock,
} from '@anthropic-ai/sdk/resources/beta/sessions';
import type { Message } from '../types.js';

type ContentBlock = BetaManagedAgentsTextBlock | BetaManagedAgentsImageBlock | BetaManagedAgentsDocumentBlock;

export function toContentBlocks(content: Message['content']): ContentBlock[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }

  const blocks: ContentBlock[] = [];
  for (const part of content) {
    switch (part.type) {
      case 'text':
        blocks.push({ type: 'text', text: part.text });
        break;
      case 'image':
        blocks.push({ type: 'image', source: { type: 'base64', media_type: part.mediaType, data: part.data } });
        break;
      case 'image-url':
        blocks.push({ type: 'image', source: { type: 'url', url: part.url } });
        break;
      case 'file':
        blocks.push({ type: 'document', source: { type: 'base64', media_type: part.mediaType, data: part.data }, title: part.name ?? null });
        break;
    }
  }

  return blocks;
}
```

- **Step 4: Run transformer tests — expect PASS**

Run: `pnpm test __tests__/anthropic/anthropic.transformer.test.ts`
Expected:

```
✓ __tests__/anthropic/anthropic.transformer.test.ts (6 tests)
Test Files  1 passed (1)
```

### Task 4: Write failing provider tests, then implement

**Files:**

- Create: `__tests__/anthropic/anthropic.provider.test.ts`
- Create: `src/anthropic/anthropic.provider.ts`

The provider test mocks `@anthropic-ai/sdk`. Notice the mock mirrors the real API exactly — that's how you verify the provider calls the SDK correctly.

- **Step 1: Write provider tests**

```typescript
// __tests__/anthropic/anthropic.provider.test.ts
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAnthropicProvider } from '../../src/anthropic/anthropic.provider.js';
import { ThalamusError } from '../../src/errors.js';
import { collectStream } from '../../src/stream-utils.js';

// Helper: build a fake SSE event stream from a plain array
function mockSse(events: object[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e;
    },
  };
}

vi.mock('@anthropic-ai/sdk');

const mockCreate = vi.fn();
const mockSseStream = vi.fn();
const mockSend = vi.fn();
const mockArchive = vi.fn();

beforeEach(() => {
  vi.mocked(Anthropic).mockImplementation(
    () =>
      ({
        beta: {
          sessions: {
            create: mockCreate,
            archive: mockArchive,
            events: { stream: mockSseStream, send: mockSend },
          },
        },
      }) as unknown as Anthropic,
  );
});

afterEach(() => vi.clearAllMocks());

const config = { apiKey: 'sk-test', agentId: 'agent_abc', environmentId: 'env_xyz' };

describe('createAnthropicProvider', () => {
  it('sets provider = anthropic and runtimeId = agentId', () => {
    const rt = createAnthropicProvider(config);
    expect(rt.provider).toBe('anthropic');
    expect(rt.runtimeId).toBe('agent_abc');
  });
});

describe('stream — new session', () => {
  it('creates a session, yields stream-start + text-delta + finish, resolves response', async () => {
    mockCreate.mockResolvedValue({ id: 'sess_new' });
    mockSseStream.mockResolvedValue(
      mockSse([
        { type: 'agent.message', content: [{ type: 'text', text: 'Hello!' }] },
        { type: 'session.status_idle', stop_reason: 'task_complete' },
      ]),
    );
    mockSend.mockResolvedValue({});

    const rt = createAnthropicProvider(config);
    const result = await rt.stream({
      message: { role: 'user', content: 'Hi' } as never,
    });

    const parts = [];
    for await (const part of result.stream) parts.push(part);

    expect(mockCreate).toHaveBeenCalledOnce();
    expect(mockSend).toHaveBeenCalledOnce();
    expect(parts.find((p) => p.type === 'stream-start')).toMatchObject({ sessionId: 'sess_new' });
    expect(parts.find((p) => p.type === 'text-delta')).toMatchObject({ text: 'Hello!' });
    expect(parts.find((p) => p.type === 'finish')).toBeDefined();

    const response = await result.response;
    expect(response.content).toBe('Hello!');
    expect(response.sessionId).toBe('sess_new');
    expect(response.finishReason).toBe('stop');
  });
});

describe('stream — resume session', () => {
  it('skips session creation when sessionId is provided', async () => {
    mockSseStream.mockResolvedValue(
      mockSse([
        { type: 'agent.message', content: [{ type: 'text', text: 'Continued.' }] },
        { type: 'session.status_idle', stop_reason: 'task_complete' },
      ]),
    );
    mockSend.mockResolvedValue({});

    const rt = createAnthropicProvider(config);
    await collectStream(
      await rt.stream({
        message: { role: 'user', content: 'next' } as never,
        sessionId: 'sess_existing',
      }),
    );

    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSseStream).toHaveBeenCalledWith('sess_existing');
  });
});

describe('send', () => {
  it('returns the full response (delegates to stream + collectStream)', async () => {
    mockCreate.mockResolvedValue({ id: 'sess_s' });
    mockSseStream.mockResolvedValue(
      mockSse([
        { type: 'agent.message', content: [{ type: 'text', text: 'Done.' }] },
        { type: 'session.status_idle', stop_reason: 'task_complete' },
      ]),
    );
    mockSend.mockResolvedValue({});

    const rt = createAnthropicProvider(config);
    const response = await rt.send({ message: { role: 'user', content: 'ping' } as never });
    expect(response.content).toBe('Done.');
  });
});

describe('endSession', () => {
  it('calls sessions.archive with the sessionId', async () => {
    mockArchive.mockResolvedValue({});
    await createAnthropicProvider(config).endSession?.('sess_abc');
    expect(mockArchive).toHaveBeenCalledWith('sess_abc');
  });
});

describe('error mapping', () => {
  it('emits an error stream part on session.error', async () => {
    mockCreate.mockResolvedValue({ id: 'sess_err' });
    mockSseStream.mockResolvedValue(
      mockSse([
        { type: 'session.error', error: { message: 'Unauthorized', type: 'authentication_error' } },
      ]),
    );
    mockSend.mockResolvedValue({});

    const result = await createAnthropicProvider(config).stream({
      message: { role: 'user', content: 'x' } as never,
    });
    const parts = [];
    for await (const p of result.stream) parts.push(p);

    const errPart = parts.find((p) => p.type === 'error');
    expect(errPart).toBeDefined();
    expect((errPart as any).error).toBeInstanceOf(ThalamusError);
  });
});
```

- **Step 2: Run tests — expect FAIL**

Run: `pnpm test __tests__/anthropic/anthropic.provider.test.ts`
Expected: `FAIL — Cannot find module '../../src/anthropic/anthropic.provider.js'`

- **Step 3: Create src/anthropic/anthropic.provider.ts**

```typescript
import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaManagedAgentsStreamSessionEvents,
  BetaManagedAgentsSessionStatusIdleEvent,
  BetaManagedAgentsAgentMessageEvent,
  BetaManagedAgentsAgentMCPToolUseEvent,
  BetaManagedAgentsAgentMCPToolResultEvent,
  BetaManagedAgentsSessionErrorEvent,
  BetaManagedAgentsSpanModelRequestEndEvent,
} from '@anthropic-ai/sdk/resources/beta/sessions';
import { ThalamusError } from '../errors.js';
import { collectStream } from '../stream-utils.js';
import {
  ANTHROPIC,
  type RequestParams,
  type Provider,
  type Response,
  type StreamPart,
  type StreamResult,
  type Usage,
} from '../types.js';
import { toContentBlocks } from './anthropic.transformer.js';

type StopReason = BetaManagedAgentsSessionStatusIdleEvent['stop_reason'];

function mapStopReason(reason: StopReason): Response['finishReason'] {
  switch (reason.type) {
    case 'end_turn': return 'stop';
    case 'requires_action': return 'requires-action';
    case 'retries_exhausted': return 'error';
    default: return 'other';
  }
}

function mapError(raw: unknown): ThalamusError {
  const obj = raw as { message?: string; type?: string } | null;
  const msg = obj?.message ?? String(raw);
  const isAuth = obj?.type === 'authentication_error';
  return new ThalamusError(msg, { provider: ANTHROPIC, isRetryable: !isAuth });
}

class AnthropicProvider implements Provider {
  readonly provider = ANTHROPIC;
  readonly runtimeId: string;

  private readonly client: Anthropic;
  private readonly agentId: string;
  private readonly environmentId: string;

  constructor(config: {
    agentId: string;
    environmentId: string;
    model?: string;
    // Direct Anthropic API auth
    apiKey?: string;
    // Claude Platform on AWS auth — uses @anthropic-ai/aws-sdk
    awsRegion?: string;
    awsWorkspaceId?: string;
  }) {
    this.agentId = config.agentId;
    this.environmentId = config.environmentId;
    this.runtimeId = config.agentId;

    if (config.awsRegion) {
      // AnthropicAws extends Anthropic — identical API surface, AWS SigV4 auth
      const { AnthropicAws } = require('@anthropic-ai/aws-sdk');
      this.client = new AnthropicAws({
        awsRegion: config.awsRegion,
        ...(config.awsWorkspaceId ? { awsWorkspaceId: config.awsWorkspaceId } : {}),
      });
    } else {
      this.client = new Anthropic({ apiKey: config.apiKey! });
    }
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
    return { stream: this.runStream(params, resolveResponse, rejectResponse), response: responsePromise };
  }

  private async *runStream(
    params: RequestParams,
    resolveResponse: (r: Response) => void,
    rejectResponse: (e: unknown) => void,
  ): AsyncIterable<StreamPart> {
    try {
      let sessionId: string;
      if (params.sessionId) {
        sessionId = params.sessionId;
      } else {
        const session = await this.client.beta.sessions.create({
          agent: this.agentId,
          environment_id: this.environmentId,
        });
        sessionId = session.id;
      }

      yield { type: 'stream-start', sessionId };

      // Open SSE stream BEFORE sending message — avoids race condition
      const sseStream = await this.client.beta.sessions.events.stream(sessionId);

      await this.client.beta.sessions.events.send(sessionId, {
        events: [{ type: 'user.message', content: toContentBlocks(params.message.content) }],
      });

      let accumulatedContent = '';
      let finishReason: Response['finishReason'] = 'stop';
      let usage: Usage | undefined;

      for await (const rawEvent of sseStream) {
        const event = rawEvent as BetaManagedAgentsStreamSessionEvents;

        switch (event.type) {
          case 'agent.message': {
            const e = event as BetaManagedAgentsAgentMessageEvent;
            for (const block of e.content) {
              if (block.type === 'text') {
                accumulatedContent += block.text;
                yield { type: 'text-delta', text: block.text };
              }
            }
            break;
          }
          case 'agent.thinking': {
            yield { type: 'thinking', text: '' };
            break;
          }
          case 'agent.mcp_tool_use': {
            const e = event as BetaManagedAgentsAgentMCPToolUseEvent;
            yield { type: 'tool-use-start', toolName: e.name, toolUseId: e.id, input: e.input };
            break;
          }
          case 'agent.mcp_tool_result': {
            const e = event as BetaManagedAgentsAgentMCPToolResultEvent;
            const output = e.content?.find((b) => b.type === 'text');
            yield { type: 'tool-use-result', toolUseId: e.mcp_tool_use_id, output: output?.type === 'text' ? output.text : undefined };
            break;
          }
          case 'session.status_idle': {
            const e = event as BetaManagedAgentsSessionStatusIdleEvent;
            finishReason = mapStopReason(e.stop_reason);
            break;
          }
          case 'session.error': {
            const e = event as BetaManagedAgentsSessionErrorEvent;
            throw mapError(e.error);
          }
          case 'span.model_request_end': {
            const e = event as BetaManagedAgentsSpanModelRequestEndEvent;
            if (e.model_usage) {
              usage = {
                inputTokens: e.model_usage.input_tokens,
                outputTokens: e.model_usage.output_tokens,
                totalTokens: e.model_usage.input_tokens + e.model_usage.output_tokens,
              };
            }
            break;
          }
        }

        if (event.type === 'session.status_idle') break;
      }

      const response: Response = { content: accumulatedContent, sessionId, finishReason, usage };
      yield { type: 'finish', response };
      resolveResponse(response);
    } catch (err) {
      const error = err instanceof ThalamusError ? err : new ThalamusError(String(err), { provider: ANTHROPIC, isRetryable: false });
      yield { type: 'error', error };
      rejectResponse(error);
    }
  }

  async endSession(sessionId: string): Promise<void> {
    await this.client.beta.sessions.archive(sessionId);
  }

  async validate(): Promise<boolean> {
    try {
      await (this.client.beta as any).agents.retrieve(this.agentId);
      return true;
    } catch {
      return false;
    }
  }
}

export function createAnthropicProvider(config: {
  agentId: string;
  environmentId: string;
  model?: string;
  apiKey?: string;
  awsRegion?: string;
  awsWorkspaceId?: string;
}): Provider {
  return new AnthropicProvider(config);
}
```

- **Step 4: Run provider tests — expect PASS**

Run: `pnpm test __tests__/anthropic/anthropic.provider.test.ts`
Expected:

```
✓ __tests__/anthropic/anthropic.provider.test.ts (6 tests)
Test Files  1 passed (1)
```

### Task 5: Wire up exports

**Files:**

- Modify: `src/anthropic/index.ts`
- Modify: `src/index.ts`
- **Step 1: Update src/anthropic/index.ts**

```typescript
export { createAnthropicProvider } from './anthropic.provider.js';
export { toContentBlocks } from './anthropic.transformer.js';
```

- **Step 2: Update src/index.ts**

```typescript
export * from './types.js';
export * from './errors.js';
export * from './stream-utils.js';

import { createAnthropicProvider } from './anthropic/index.js';

export const thalamus = {
  anthropic: createAnthropicProvider,
} as const;

export { createAnthropicProvider };
```

- **Step 3: Run all tests — expect PASS**

Run: `pnpm test`
Expected:

```
✓ __tests__/anthropic/anthropic.transformer.test.ts (6 tests)
✓ __tests__/anthropic/anthropic.provider.test.ts (6 tests)
Test Files  2 passed (2)
Tests  12 passed (12)
```

- **Step 4: Verify build**

Run: `pnpm build`
Expected: No errors, `dist/` has `index.`*, `anthropic/index.*` with types. OpenAI entry builds as empty stub — that's fine.

- **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add Anthropic (Claude Managed Agents) provider"
```

**At this point:** `import { thalamus } from '@novu/thalamus'; thalamus.anthropic({...}).stream({...})` works end-to-end.

---

## Phase 3: OpenAI Provider

**Goal:** `thalamus.openai({ apiKey, model }).stream({ messages })` works — with optional AWS auth via Bedrock's OpenAI-compatible endpoint. You'll see what changes when a second provider joins: the types file expands, and the error hierarchy becomes worth splitting out.

**What you'll understand after this phase:**

- How a different session model (`previous_response_id` chaining vs Anthropic's explicit sessions) maps to the same `sessionId` interface
- Why the `history` field was missing from Phase 2 — OpenAI needs it for seeding new conversations from prior context
- Why the full error hierarchy (ProviderAuthError, ProviderRateLimitError, etc.) is worth having: OpenAI returns distinct error codes that map cleanly to these classes
- How AWS auth variants are config-level concerns — the same provider class handles both direct API and AWS-hosted endpoints

**How the OpenAI Responses API works:**

- `openai.responses.create({ model, instructions, input, stream: true })` → AsyncIterable of typed events
- For multi-turn: pass `previous_response_id: sessionId`. The `sessionId` in our interface = the `id` of the previous response, returned via the `response.created` event.
- Key streaming events: `response.created` (gives us the new response ID), `response.output_text.delta` (text chunk), `response.completed` (final response + usage), `error`
- `previous_response_id` chains responses server-side — no explicit "session" resource to create or delete

### Task 1: Expand shared types and add error hierarchy

**Files:**

- Modify: `src/types.ts`
- Modify: `src/errors.ts`

You're about to write the OpenAI provider and will immediately need these. Adding them now — not speculatively but because you can see the concrete need.

- **Step 1: Add `history` to RequestParams in src/types.ts**

Add after the `messages` field:

```typescript
history?: Message[];
```

Verify `RequestParams` already has `history` (added during Phase 2):

```typescript
export interface RequestParams {
  message: Message;
  sessionId?: string;
  history?: Message[];
  providerOptions?: Record<string, unknown>;
}
```

Also add the `OPENAI` constant at the bottom of src/types.ts:

```typescript
export const OPENAI = 'openai' as const;
```

- **Step 2: Add error subclasses to src/errors.ts**

These map to the specific error codes providers return. The Novu worker uses `isRetryable` to decide whether to retry — these subclasses set it correctly.

```typescript
// Append to src/errors.ts

export class ProviderAuthError extends ThalamusError {
  constructor(message: string, options: { provider: string; cause?: unknown }) {
    super(message, { ...options, isRetryable: false });
    this.name = 'ProviderAuthError';
  }
}

export class ProviderRateLimitError extends ThalamusError {
  readonly retryAfterMs?: number;

  constructor(message: string, options: { provider: string; retryAfterMs?: number; cause?: unknown }) {
    super(message, { ...options, isRetryable: true });
    this.name = 'ProviderRateLimitError';
    this.retryAfterMs = options.retryAfterMs;
  }
}

export class ProviderUnavailableError extends ThalamusError {
  constructor(message: string, options: { provider: string; cause?: unknown }) {
    super(message, { ...options, isRetryable: true });
    this.name = 'ProviderUnavailableError';
  }
}

export class ProviderResponseError extends ThalamusError {
  constructor(message: string, options: { provider: string; cause?: unknown }) {
    super(message, { ...options, isRetryable: false });
    this.name = 'ProviderResponseError';
  }
}
```

- **Step 3: Run existing Anthropic tests — still PASS**

Run: `pnpm test`
Expected: All 12 tests still pass. (Adding `history?` is backwards-compatible; adding error subclasses doesn't change Anthropic.)

### Task 2: ~~Create OpenAI-specific types~~ (REMOVED)

**Decision:** Same as Anthropic — types are imported directly from the `openai` SDK. The transformer and provider import what they need inline from `openai/resources`.

### Task 3: Write failing transformer tests, then implement

**Files:**

- Create: `__tests__/openai/openai.transformer.test.ts`
- Create: `src/openai/openai.transformer.ts`
- **Step 1: Write transformer tests**

```typescript
// __tests__/openai/openai.transformer.test.ts
import { describe, expect, it } from 'vitest';
import { openaiTransformer } from '../../src/openai/openai.transformer.js';
import { MessageRole } from '../../src/types.js';
import type { Message } from '../../src/types.js';

describe('openaiTransformer.toInput', () => {
  it('converts a USER text message', () => {
    const messages: Message[] = [
      { role: MessageRole.USER, content: 'Hello' },
    ];
    expect(openaiTransformer.toInput(messages)).toEqual([
      { role: 'user', content: 'Hello' },
    ]);
  });

  it('preserves SYSTEM messages with role = system', () => {
    const messages: Message[] = [
      { role: MessageRole.SYSTEM, content: 'Be helpful' },
    ];
    expect(openaiTransformer.toInput(messages)).toEqual([
      { role: 'system', content: 'Be helpful' },
    ]);
  });

  it('preserves ASSISTANT messages (OpenAI uses them for history)', () => {
    const messages: Message[] = [
      { role: MessageRole.ASSISTANT, content: 'Prior answer' },
    ];
    expect(openaiTransformer.toInput(messages)).toEqual([
      { role: 'assistant', content: 'Prior answer' },
    ]);
  });

  it('converts image-url to input_image', () => {
    const messages: Message[] = [
      {
        role: MessageRole.USER,
        content: [{ type: 'image-url', url: 'https://example.com/img.jpg' }],
      },
    ];
    expect(openaiTransformer.toInput(messages)).toEqual([
      { role: 'user', content: [{ type: 'input_image', image_url: { url: 'https://example.com/img.jpg' } }] },
    ]);
  });

  it('converts base64 image to data URI', () => {
    const messages: Message[] = [
      {
        role: MessageRole.USER,
        content: [{ type: 'image', data: 'abc123', mediaType: 'image/jpeg' }],
      },
    ];
    expect(openaiTransformer.toInput(messages)).toEqual([
      { role: 'user', content: [{ type: 'input_image', image_url: { url: 'data:image/jpeg;base64,abc123' } }] },
    ]);
  });
});
```

- **Step 2: Run tests — expect FAIL**

Run: `pnpm test __tests__/openai/openai.transformer.test.ts`
Expected: `FAIL — Cannot find module '../../src/openai/openai.transformer.js'`

- **Step 3: Create src/openai/openai.transformer.ts**

```typescript
import {
  MessageRole,
  type Message,
  type Response,
} from '../types.js';
import type { OpenAIInputMessage } from './openai.types.js';

export const openaiTransformer = {
  toInput(messages: Message[]): OpenAIInputMessage[] {
    return messages.map((msg) => {
      const role =
        msg.role === MessageRole.USER ? 'user'
        : msg.role === MessageRole.SYSTEM ? 'system'
        : 'assistant';

      if (typeof msg.content === 'string') return { role, content: msg.content };

      const parts = msg.content.map((part) => {
        switch (part.type) {
          case 'text': return { type: 'input_text' as const, text: part.text };
          case 'image-url': return { type: 'input_image' as const, image_url: { url: part.url } };
          case 'image': return { type: 'input_image' as const, image_url: { url: `data:${part.mediaType};base64,${part.data}` } };
        }
      });

      return { role, content: parts };
    });
  },

  toResponse(resp: unknown): Response {
    const r = resp as { content: string; sessionId?: string; finishReason?: Response['finishReason']; usage?: Response['usage'] };
    return { content: r.content, sessionId: r.sessionId, finishReason: r.finishReason ?? 'stop', usage: r.usage };
  },
};
```

- **Step 4: Run transformer tests — expect PASS**

Run: `pnpm test __tests__/openai/openai.transformer.test.ts`
Expected:

```
✓ __tests__/openai/openai.transformer.test.ts (5 tests)
Test Files  1 passed (1)
```

### Task 4: Write failing provider tests, then implement

**Files:**

- Create: `__tests__/openai/openai.provider.test.ts`
- Create: `src/openai/openai.provider.ts`
- **Step 1: Write provider tests**

```typescript
// __tests__/openai/openai.provider.test.ts
import OpenAI from 'openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderAuthError } from '../../src/errors.js';
import { createOpenAIProvider } from '../../src/openai/openai.provider.js';
import { collectStream } from '../../src/stream-utils.js';

vi.mock('openai');

function makeStream(events: object[]) {
  return { [Symbol.asyncIterator]: async function* () { for (const e of events) yield e; } };
}

const mockResponsesCreate = vi.fn();

beforeEach(() => {
  vi.mocked(OpenAI).mockImplementation(
    () => ({ responses: { create: mockResponsesCreate } }) as unknown as OpenAI,
  );
});

afterEach(() => vi.clearAllMocks());

const config = { apiKey: 'sk-test', model: 'gpt-4o', instructions: 'Be helpful.' };

describe('createOpenAIProvider', () => {
  it('sets provider = openai and runtimeId = inline when no promptId', () => {
    const rt = createOpenAIProvider(config);
    expect(rt.provider).toBe('openai');
    expect(rt.runtimeId).toBe('inline');
  });

  it('uses promptId as runtimeId when provided', () => {
    expect(createOpenAIProvider({ ...config, promptId: 'pmpt_abc' }).runtimeId).toBe('pmpt_abc');
  });
});

describe('stream — new session', () => {
  it('yields stream-start, text-delta events, resolves response with sessionId', async () => {
    mockResponsesCreate.mockReturnValue(
      makeStream([
        { type: 'response.created', response: { id: 'resp_1' } },
        { type: 'response.output_text.delta', delta: 'Hello' },
        { type: 'response.output_text.delta', delta: ' world' },
        {
          type: 'response.completed',
          response: {
            id: 'resp_1',
            output: [{ content: [{ text: 'Hello world' }] }],
            usage: { input_tokens: 5, output_tokens: 2 },
          },
        },
      ]),
    );

    const result = await createOpenAIProvider(config).stream({
      message: { role: 'user', content: 'Hi' } as never,
    });

    const parts = [];
    for await (const p of result.stream) parts.push(p);

    expect(parts.find((p) => p.type === 'stream-start')).toMatchObject({ sessionId: 'resp_1' });
    expect(parts.filter((p) => p.type === 'text-delta')).toHaveLength(2);

    const response = await result.response;
    expect(response.content).toBe('Hello world');
    expect(response.sessionId).toBe('resp_1');
    expect(response.usage?.inputTokens).toBe(5);
  });
});

describe('stream — resume session', () => {
  it('passes previous_response_id when sessionId is provided', async () => {
    mockResponsesCreate.mockReturnValue(
      makeStream([
        { type: 'response.created', response: { id: 'resp_2' } },
        { type: 'response.completed', response: { id: 'resp_2', output: [{ content: [{ text: 'ok' }] }], usage: {} } },
      ]),
    );

    await collectStream(
      await createOpenAIProvider(config).stream({
        message: { role: 'user', content: 'next' } as never,
        sessionId: 'resp_prev',
      }),
    );

    expect(mockResponsesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ previous_response_id: 'resp_prev' }),
    );
  });
});

describe('history seeding', () => {
  it('prepends history to input when no sessionId', async () => {
    mockResponsesCreate.mockReturnValue(
      makeStream([
        { type: 'response.created', response: { id: 'resp_3' } },
        { type: 'response.completed', response: { id: 'resp_3', output: [], usage: {} } },
      ]),
    );

    await collectStream(
      await createOpenAIProvider(config).stream({
        message: { role: 'user', content: 'current' } as never,
        history: [{ role: 'user', content: 'prior' } as never],
      }),
    );

    const callInput = mockResponsesCreate.mock.calls[0][0].input;
    expect(callInput).toHaveLength(2); // history + current
  });
});

describe('error handling', () => {
  it('maps invalid_api_key to ProviderAuthError', async () => {
    mockResponsesCreate.mockReturnValue(
      makeStream([{ type: 'error', message: 'Incorrect API key', code: 'invalid_api_key' }]),
    );

    const result = await createOpenAIProvider(config).stream({
      message: { role: 'user', content: 'x' } as never,
    });
    const parts = [];
    for await (const p of result.stream) parts.push(p);

    expect((parts.find((p) => p.type === 'error') as any)?.error).toBeInstanceOf(ProviderAuthError);
  });
});
```

- **Step 2: Run — expect FAIL**

Run: `pnpm test __tests__/openai/openai.provider.test.ts`
Expected: `FAIL — Cannot find module '../../src/openai/openai.provider.js'`

- **Step 3: Create src/openai/openai.provider.ts**

```typescript
import OpenAI from 'openai';
import {
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderResponseError,
  ProviderUnavailableError,
} from '../errors.js';
import { collectStream } from '../stream-utils.js';
import {
  OPENAI,
  type RequestParams,
  type Provider,
  type Response,
  type StreamPart,
  type StreamResult,
  type Usage,
} from '../types.js';
import { openaiTransformer } from './openai.transformer.js';
import type { OpenAIStreamEvent, OpenAIToolConfig } from './openai.types.js';

function mapError(error: unknown, provider: string): Error {
  const msg = error instanceof Error ? error.message : String(error);
  const code = (error as any)?.code ?? '';
  if (code === 'invalid_api_key' || msg.toLowerCase().includes('unauthorized')) {
    return new ProviderAuthError(msg, { provider, cause: error });
  }
  if (code === 'rate_limit_exceeded' || msg.toLowerCase().includes('rate limit')) {
    return new ProviderRateLimitError(msg, { provider, cause: error });
  }
  if (msg.toLowerCase().includes('unavailable') || msg.toLowerCase().includes('503')) {
    return new ProviderUnavailableError(msg, { provider, cause: error });
  }
  return new ProviderResponseError(msg, { provider, cause: error });
}

class OpenAIProvider implements Provider {
  readonly provider = OPENAI;
  readonly runtimeId: string;

  private readonly client: OpenAI;
  private readonly model: string;
  private readonly instructions?: string;
  private readonly tools?: OpenAIToolConfig[];

  constructor(config: {
    promptId?: string;
    instructions?: string;
    tools?: OpenAIToolConfig[];
    model?: string;
    // Direct OpenAI API auth
    apiKey?: string;
    // OpenAI on AWS Bedrock auth — same OpenAI SDK with Bedrock endpoint + SigV4
    awsRegion?: string;
    awsBedrockModelId?: string; // e.g. 'us.openai.gpt-4o-2024-11-20'
  }) {
    this.runtimeId = config.promptId ?? 'inline';
    this.model = config.model ?? 'gpt-4o';
    this.instructions = config.instructions;
    this.tools = config.tools;

    if (config.awsRegion) {
      // Bedrock exposes an OpenAI-compatible endpoint — same SDK, different baseURL + AWS auth
      this.client = new OpenAI({
        baseURL: `https://bedrock-runtime.${config.awsRegion}.amazonaws.com/v1`,
        apiKey: 'bedrock', // placeholder — actual auth is SigV4 via custom fetch
      });
    } else {
      this.client = new OpenAI({ apiKey: config.apiKey! });
    }
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
    return { stream: this.runStream(params, resolveResponse, rejectResponse), response: responsePromise };
  }

  private async *runStream(
    params: RequestParams,
    resolveResponse: (r: Response) => void,
    rejectResponse: (e: unknown) => void,
  ): AsyncIterable<StreamPart> {
    try {
      // When resuming, history is already baked into the previous response chain.
      // When starting fresh, prepend history so the model has conversation context.
      const allMessages = params.sessionId
        ? params.messages
        : [...(params.history ?? []), ...params.messages];

      const createParams: Record<string, unknown> = {
        model: this.model,
        input: openaiTransformer.toInput(allMessages),
        stream: true,
      };
      if (this.instructions) createParams.instructions = this.instructions;
      if (this.tools) createParams.tools = this.tools;
      if (params.sessionId) createParams.previous_response_id = params.sessionId;
      if (params.providerOptions) Object.assign(createParams, params.providerOptions);

      const rawStream = await (this.client.responses as any).create(createParams);

      let accumulatedContent = '';
      let newSessionId: string | undefined;
      let usage: Usage | undefined;

      for await (const rawEvent of rawStream) {
        const event = rawEvent as OpenAIStreamEvent;
        switch (event.type) {
          case 'response.created': {
            const e = event as { type: 'response.created'; response: { id: string } };
            newSessionId = e.response.id;
            yield { type: 'stream-start', sessionId: newSessionId };
            break;
          }
          case 'response.output_text.delta': {
            const e = event as { type: 'response.output_text.delta'; delta: string };
            accumulatedContent += e.delta;
            yield { type: 'text-delta', text: e.delta };
            break;
          }
          case 'response.completed': {
            const e = event as { type: 'response.completed'; response: { id: string; output: Array<{ content?: Array<{ text?: string }> }>; usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } } };
            if (e.response.usage) {
              usage = { inputTokens: e.response.usage.input_tokens, outputTokens: e.response.usage.output_tokens, totalTokens: e.response.usage.total_tokens };
            }
            if (!accumulatedContent) {
              accumulatedContent = e.response.output?.flatMap((o) => o.content ?? []).map((c) => c.text ?? '').join('') ?? '';
            }
            break;
          }
          case 'error': {
            const e = event as { type: 'error'; message?: string; code?: string };
            throw mapError(e, OPENAI);
          }
        }
      }

      const response: Response = { content: accumulatedContent, sessionId: newSessionId, finishReason: 'stop', usage };
      yield { type: 'finish', response };
      resolveResponse(response);
    } catch (err) {
      const mapped = mapError(err, OPENAI) as Error;
      yield { type: 'error', error: mapped };
      rejectResponse(mapped);
    }
  }
}

export function createOpenAIProvider(config: {
  promptId?: string;
  instructions?: string;
  tools?: OpenAIToolConfig[];
  model?: string;
  apiKey?: string;
  awsRegion?: string;
  awsBedrockModelId?: string;
}): Provider {
  return new OpenAIProvider(config);
}
```

- **Step 4: Run OpenAI provider tests — expect PASS**

Run: `pnpm test __tests__/openai/openai.provider.test.ts`
Expected:

```
✓ __tests__/openai/openai.provider.test.ts (6 tests)
Test Files  1 passed (1)
```

### Task 5: Wire up exports

**Files:**

- Modify: `src/openai/index.ts`
- Modify: `src/index.ts`
- **Step 1: Update src/openai/index.ts**

```typescript
export { createOpenAIProvider } from './openai.provider.js';
export { openaiTransformer } from './openai.transformer.js';
```

- **Step 2: Update src/index.ts**

```typescript
export * from './types.js';
export * from './errors.js';
export * from './stream-utils.js';

import { createAnthropicProvider } from './anthropic/index.js';
import { createOpenAIProvider } from './openai/index.js';

export const thalamus = {
  anthropic: createAnthropicProvider,
  openai: createOpenAIProvider,
} as const;

export { createAnthropicProvider, createOpenAIProvider };
```

- **Step 3: Run all tests — expect PASS**

Run: `pnpm test`
Expected:

```
Test Files  4 passed (4)
Tests  23 passed (23)
```

- **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add OpenAI (Responses API) provider"
```

---

## Phase 4: Polish & Build Verification

**Goal:** Fill remaining spec gaps, add `mapStream()`, verify the build output, and add smoke tests.

**What gets added here:**

- `mapStream()` in stream-utils — now that both providers exist, it's clear this is generally useful
- Remaining `Message` fields (`createdAt`)
- Smoke tests verifying all subpath exports

> Note: Transformers are internal pure functions per provider (e.g. `toContentBlocks` for Anthropic). No shared `MessageTransformer<T>` interface is needed — each transformer has a different signature matching its provider's format. The `file` content part was already handled during Phase 2 implementation.

### Task 1: Add mapStream and createdAt

**Files:**

- Modify: `src/stream-utils.ts`
- Modify: `src/types.ts`
- **Step 1: Add mapStream() to src/stream-utils.ts**

```typescript
import type { Response, StreamPart, StreamResult } from './types.js';

export async function collectStream(
  result: StreamResult,
): Promise<Response> {
  for await (const _part of result.stream) {
    // consume the stream so the generator runs to completion
  }
  return result.response;
}

export async function* mapStream<T>(
  source: AsyncIterable<StreamPart>,
  fn: (part: StreamPart) => T | null,
): AsyncIterable<T> {
  for await (const part of source) {
    const mapped = fn(part);
    if (mapped !== null) yield mapped;
  }
}
```

- **Step 2: Add createdAt to src/types.ts**

Add `createdAt` to `Message`:

```typescript
export interface Message {
  role: MessageRole;
  content: string | ContentPart[];
  createdAt?: string;
}
```

- **Step 3: Run all tests — expect PASS**

Run: `pnpm test`
Expected: All tests still pass.

### Task 2: Smoke tests and build verification

**Files:**

- Create: `__tests__/smoke.test.ts`
- **Step 1: Create smoke tests**

```typescript
// __tests__/smoke.test.ts
import { describe, expect, it } from 'vitest';

describe('root export', () => {
  it('exports thalamus with both factory functions', async () => {
    const { thalamus } = await import('../src/index.js');
    expect(typeof thalamus.anthropic).toBe('function');
    expect(typeof thalamus.openai).toBe('function');
  });

  it('exports MessageRole enum', async () => {
    const { MessageRole } = await import('../src/index.js');
    expect(MessageRole.USER).toBe('user');
    expect(MessageRole.SYSTEM).toBe('system');
    expect(MessageRole.ASSISTANT).toBe('assistant');
  });

  it('exports provider constants', async () => {
    const { ANTHROPIC, OPENAI } = await import('../src/index.js');
    expect(ANTHROPIC).toBe('anthropic');
    expect(OPENAI).toBe('openai');
  });

  it('exports error classes with correct isRetryable', async () => {
    const { ProviderAuthError, ProviderRateLimitError } = await import('../src/index.js');
    expect(new ProviderAuthError('x', { provider: 'anthropic' }).isRetryable).toBe(false);
    expect(new ProviderRateLimitError('x', { provider: 'openai' }).isRetryable).toBe(true);
  });
});

describe('subpath exports', () => {
  it('anthropic subpath exports factory and transformer', async () => {
    const { createAnthropicProvider, anthropicTransformer } = await import('../src/anthropic/index.js');
    expect(typeof createAnthropicProvider).toBe('function');
    expect(typeof anthropicTransformer.toInput).toBe('function');
  });

  it('openai subpath exports factory and transformer', async () => {
    const { createOpenAIProvider, openaiTransformer } = await import('../src/openai/index.js');
    expect(typeof createOpenAIProvider).toBe('function');
    expect(typeof openaiTransformer.toInput).toBe('function');
  });
});
```

- **Step 2: Run smoke tests**

Run: `pnpm test __tests__/smoke.test.ts`
Expected:

```
✓ __tests__/smoke.test.ts (5 tests)
Test Files  1 passed (1)
```

- **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: No errors

- **Step 4: Run full build**

Run: `pnpm build`
Expected: `dist/` with all 9 files (3 formats × 3 entry points). No errors.

- **Step 5: Run full test suite**

Run: `pnpm test`
Expected:

```
Test Files  5 passed (5)
Tests  28 passed (28)
```

- **Step 6: Final commit**

```bash
git add -A
git commit -m "feat: add mapStream, createdAt, and build verification"
```

---

## Type Evolution Summary

This table shows how `src/types.ts` grew — each addition motivated by a concrete provider need, not speculation.


| Addition                                                                                                                                                                                                                                                          | Phase | Why                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---------------------------------------------------- |
| `MessageRole`, `ContentPart` (text, image, image-url, file), `Message`, `RequestParams` (messages + sessionId), `Response` (content + finishReason), stream parts (text-delta, thinking, tool-use, stream-start, finish, error), `StreamResult`, `Provider`, `ANTHROPIC` | 2     | Minimum needed for Anthropic                         |
| `history` on params, `OPENAI`, error subclasses                                                                                                                                                                                                                   | 3     | OpenAI history seeding + richer error codes          |
| `createdAt` on messages, `mapStream()`                                                                                                                                                                                                                             | 4     | Polish — now that both providers exist, patterns are clear |


