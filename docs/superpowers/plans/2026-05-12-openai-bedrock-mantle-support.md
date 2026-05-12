# OpenAI Bedrock Mantle Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Amazon Bedrock (bedrock-mantle) authentication support to the existing OpenAI provider so users can call OpenAI models hosted on AWS Bedrock using the same `thalamus.openai()` interface.

**Architecture:** Auth variant within the existing `createOpenAIProvider()`. The config type becomes a discriminated union — callers pass either `apiKey` (direct OpenAI API) or `awsRegion` (Bedrock). Two Bedrock auth modes: Bedrock API Key (simple bearer token swap) and AWS SigV4 (custom fetch signing). No new providers, no new subpath exports — the API surface is identical, only authentication and `baseURL` differ.

**Tech Stack:** TypeScript (ES2022), vitest, `openai` SDK (peer dep, already declared), `@aws-sdk/credential-providers` + `@smithy/signature-v4` + `@aws-crypto/sha256-js` (new optional peer deps for SigV4 only).

**Approach:** Two phases. Phase 1 adds Bedrock API Key auth (zero new deps — just `baseURL` + `apiKey` swap on the OpenAI client). Phase 2 adds SigV4 auth via a custom `fetch` function injected into the OpenAI client. A verification phase confirms the Conversations API works on Bedrock.

**Dependencies:**
- Phase 1: None — uses existing `openai` peer dep
- Phase 2: `@aws-sdk/credential-providers`, `@smithy/signature-v4`, `@aws-crypto/sha256-js` (all optional peer deps)

**Key insight from research:** AWS Bedrock exposes the OpenAI Responses API at `https://bedrock-mantle.{region}.api.aws/v1`. The API is fully compatible — same endpoints, same streaming events, same conversation management. Only auth and model IDs differ (e.g. `openai.gpt-oss-120b` instead of `gpt-4o`).

---

## File Structure (changes relative to current codebase)

```
src/
  openai/
    openai.provider.ts          # Phase 1: discriminated union config, Bedrock baseURL
                                # Phase 2: SigV4 custom fetch
    sigv4-fetch.ts              # Phase 2: createSigV4Fetch() helper
    index.ts                    # No changes (re-exports provider + transformer)

package.json                    # Phase 2: new optional peer deps

__tests__/
  openai/
    openai.provider.test.ts     # Phase 1: new tests for Bedrock API Key path
                                # Phase 2: new tests for SigV4 path
    sigv4-fetch.test.ts         # Phase 2: unit tests for signing logic
```

---

## Phase 1: Bedrock API Key Auth

**Goal:** `createOpenAIProvider({ awsRegion: 'us-east-1', awsBedrockApiKey: 'bedrock-api-key-...', model: 'openai.gpt-oss-120b' })` creates a provider that routes to the bedrock-mantle endpoint. Existing `apiKey` config continues to work unchanged.

**What changes:**
- `OpenAIProviderConfig` becomes a discriminated union (direct OpenAI vs Bedrock)
- Constructor branches: if `awsRegion` is present, set `baseURL` to `https://bedrock-mantle.{region}.api.aws/v1` and use `awsBedrockApiKey` as the API key
- Model defaults to `openai.gpt-4o` on Bedrock (model IDs have `openai.` prefix)

### Task 1: Write failing tests for Bedrock API Key config

**Files:**

- Modify: `__tests__/openai/openai.provider.test.ts`

- [ ] **Step 1: Add test cases for Bedrock API Key config**

Append this describe block to `__tests__/openai/openai.provider.test.ts`:

```typescript
const bedrockConfig = {
  awsRegion: 'us-east-1',
  awsBedrockApiKey: 'bedrock-api-key-abc123',
  model: 'openai.gpt-oss-120b',
  instructions: 'Be helpful.',
};

describe('Bedrock API Key auth', () => {
  it('sets provider = openai and runtimeId = inline', () => {
    const rt = createOpenAIProvider(bedrockConfig);
    expect(rt.provider).toBe('openai');
    expect(rt.runtimeId).toBe('inline');
  });

  it('streams successfully via bedrock-mantle endpoint', async () => {
    mockConversationsCreate.mockResolvedValue({ id: 'conv_br' });
    mockResponsesCreate.mockReturnValue(
      makeStream([
        { type: 'response.created', response: { id: 'resp_br', conversation: { id: 'conv_br' } } },
        { type: 'response.output_text.delta', delta: 'Hello from Bedrock!' },
        {
          type: 'response.completed',
          response: { id: 'resp_br', output_text: 'Hello from Bedrock!', usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } },
        },
      ]),
    );

    const result = await createOpenAIProvider(bedrockConfig).stream({
      messages: [{ role: 'user', content: 'Hi' } as never],
    });
    const parts = [];
    for await (const p of result.stream) parts.push(p);

    const response = await result.response;
    expect(response.content).toBe('Hello from Bedrock!');
    expect(response.sessionId).toBe('conv_br');
  });
});
```

- [ ] **Step 2: Verify the mock captures the OpenAI client constructor args**

Update the `vi.mock('openai', ...)` block to capture the config passed to the OpenAI constructor:

```typescript
let lastOpenAIConfig: Record<string, unknown> | undefined;

vi.mock('openai', () => {
  const MockOpenAI = function (config: Record<string, unknown>) {
    lastOpenAIConfig = config;
    return {
      responses: { create: mockResponsesCreate },
      conversations: { create: mockConversationsCreate },
    };
  };
  return { default: MockOpenAI };
});
```

Add a test that verifies the correct baseURL is set:

```typescript
describe('Bedrock API Key auth — client config', () => {
  it('passes bedrock-mantle baseURL and awsBedrockApiKey to OpenAI client', () => {
    createOpenAIProvider(bedrockConfig);
    expect(lastOpenAIConfig).toMatchObject({
      baseURL: 'https://bedrock-mantle.us-east-1.api.aws/v1',
      apiKey: 'bedrock-api-key-abc123',
    });
  });

  it('does NOT set baseURL for direct OpenAI config', () => {
    createOpenAIProvider(config);
    expect(lastOpenAIConfig).toMatchObject({
      apiKey: 'sk-test',
    });
    expect(lastOpenAIConfig?.baseURL).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run tests — expect FAIL**

Run: `pnpm test __tests__/openai/openai.provider.test.ts`
Expected: FAIL — `createOpenAIProvider` does not accept `awsRegion` / `awsBedrockApiKey` in its config type.

### Task 2: Refactor config type and add Bedrock client path

**Files:**

- Modify: `src/openai/openai.provider.ts`

- [ ] **Step 1: Replace `OpenAIProviderConfig` with a discriminated union**

Replace the existing `OpenAIProviderConfig` interface:

```typescript
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

type OpenAIBaseConfig = {
  model?: string;
  promptId?: string;
  instructions?: string;
};

export type OpenAIProviderConfig = OpenAIBaseConfig & (OpenAIDirectConfig | OpenAIBedrockApiKeyConfig);
```

- [ ] **Step 2: Update the constructor to branch on auth mode**

Replace the constructor:

```typescript
  constructor(config: OpenAIProviderConfig) {
    this.runtimeId = config.promptId ?? 'inline';
    this.model = config.model ?? 'gpt-4o';
    this.instructions = config.instructions;

    if ('awsRegion' in config && config.awsRegion) {
      this.client = new OpenAI({
        baseURL: `https://bedrock-mantle.${config.awsRegion}.api.aws/v1`,
        apiKey: config.awsBedrockApiKey,
      });
    } else {
      this.client = new OpenAI({ apiKey: config.apiKey });
    }
  }
```

- [ ] **Step 3: Update the `createOpenAIProvider` function signature**

```typescript
export function createOpenAIProvider(config: OpenAIProviderConfig): Provider {
  return new OpenAIProvider(config);
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `pnpm test __tests__/openai/openai.provider.test.ts`
Expected: All tests pass — existing direct API tests unchanged, new Bedrock tests pass.

- [ ] **Step 5: Run full test suite and build**

Run: `pnpm test && pnpm build`
Expected: All tests pass, build succeeds.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add Bedrock API Key auth variant to OpenAI provider"
```

---

## Phase 2: SigV4 Auth

**Goal:** `createOpenAIProvider({ awsRegion: 'us-east-1', awsCredentials: { accessKeyId, secretAccessKey } })` creates a provider that signs requests with AWS SigV4. For environments using IAM roles (ECS, Lambda, EKS with IRSA).

**What changes:**
- New `OpenAIBedrockSigV4Config` added to the union
- New `src/openai/sigv4-fetch.ts` — builds a custom `fetch` function that signs requests
- `package.json` gains optional peer deps for AWS signing packages
- Constructor passes `{ baseURL, apiKey: 'bedrock', fetch: sigV4Fetch }` to OpenAI client

### Task 1: Add AWS signing dependencies

**Files:**

- Modify: `package.json`

- [ ] **Step 1: Add optional peer dependencies**

Add to `peerDependencies`:

```json
"@aws-sdk/credential-providers": ">=3.500.0",
"@smithy/signature-v4": ">=3.0.0",
"@aws-crypto/sha256-js": ">=5.0.0"
```

Add to `peerDependenciesMeta`:

```json
"@aws-sdk/credential-providers": { "optional": true },
"@smithy/signature-v4": { "optional": true },
"@aws-crypto/sha256-js": { "optional": true }
```

Add to `devDependencies`:

```json
"@aws-sdk/credential-providers": "latest",
"@smithy/signature-v4": "latest",
"@aws-crypto/sha256-js": "latest"
```

- [ ] **Step 2: Install**

Run: `pnpm install`
Expected: No errors. Lockfile updated.

### Task 2: Create SigV4 fetch helper

**Files:**

- Create: `src/openai/sigv4-fetch.ts`

- [ ] **Step 1: Implement `createSigV4Fetch`**

```typescript
import type { AwsCredentialIdentity } from '@smithy/types';

export interface SigV4FetchOptions {
  region: string;
  credentials: AwsCredentialIdentity | (() => Promise<AwsCredentialIdentity>);
  service?: string;
}

export function createSigV4Fetch(options: SigV4FetchOptions): typeof globalThis.fetch {
  const { region, service = 'bedrock' } = options;

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<globalThis.Response> => {
    const { SignatureV4 } = await import('@smithy/signature-v4');
    const { Sha256 } = await import('@aws-crypto/sha256-js');

    const credentials = typeof options.credentials === 'function'
      ? await options.credentials()
      : options.credentials;

    const signer = new SignatureV4({
      service,
      region,
      credentials,
      sha256: Sha256,
    });

    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const body = init?.body ? String(init.body) : undefined;

    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers;
      if (h instanceof Headers) {
        h.forEach((v, k) => { headers[k] = v; });
      } else if (Array.isArray(h)) {
        for (const [k, v] of h) headers[k] = v;
      } else {
        Object.assign(headers, h);
      }
    }

    const signed = await signer.sign({
      method: init?.method ?? 'GET',
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port ? Number(url.port) : undefined,
      path: url.pathname + url.search,
      headers: { ...headers, host: url.host },
      body,
    });

    return globalThis.fetch(input, {
      ...init,
      headers: signed.headers as Record<string, string>,
    });
  };
}
```

- [ ] **Step 2: Run build to verify no type errors**

Run: `pnpm build`
Expected: Builds successfully (dynamic imports defer the optional deps to runtime).

### Task 3: Write failing tests for SigV4 config

**Files:**

- Modify: `__tests__/openai/openai.provider.test.ts`

- [ ] **Step 1: Add test cases for SigV4 config**

Append:

```typescript
const sigv4Config = {
  awsRegion: 'us-west-2',
  awsCredentials: {
    accessKeyId: 'AKIA...',
    secretAccessKey: 'secret...',
  },
  model: 'openai.gpt-oss-120b',
};

describe('Bedrock SigV4 auth', () => {
  it('sets provider = openai', () => {
    const rt = createOpenAIProvider(sigv4Config);
    expect(rt.provider).toBe('openai');
  });

  it('passes bedrock-mantle baseURL and custom fetch to OpenAI client', () => {
    createOpenAIProvider(sigv4Config);
    expect(lastOpenAIConfig?.baseURL).toBe('https://bedrock-mantle.us-west-2.api.aws/v1');
    expect(typeof lastOpenAIConfig?.fetch).toBe('function');
  });

  it('streams successfully via SigV4-signed requests', async () => {
    mockConversationsCreate.mockResolvedValue({ id: 'conv_sv4' });
    mockResponsesCreate.mockReturnValue(
      makeStream([
        { type: 'response.created', response: { id: 'resp_sv4', conversation: { id: 'conv_sv4' } } },
        { type: 'response.output_text.delta', delta: 'Signed!' },
        {
          type: 'response.completed',
          response: { id: 'resp_sv4', output_text: 'Signed!', usage: {} },
        },
      ]),
    );

    const result = await createOpenAIProvider(sigv4Config).stream({
      messages: [{ role: 'user', content: 'Hi' } as never],
    });
    const parts = [];
    for await (const p of result.stream) parts.push(p);

    const response = await result.response;
    expect(response.content).toBe('Signed!');
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `pnpm test __tests__/openai/openai.provider.test.ts`
Expected: FAIL — `awsCredentials` is not accepted by the config type.

### Task 4: Integrate SigV4 into the provider

**Files:**

- Modify: `src/openai/openai.provider.ts`

- [ ] **Step 1: Add `OpenAIBedrockSigV4Config` to the union**

```typescript
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

export type OpenAIProviderConfig = OpenAIBaseConfig & (
  | OpenAIDirectConfig
  | OpenAIBedrockApiKeyConfig
  | OpenAIBedrockSigV4Config
);
```

- [ ] **Step 2: Update the constructor to handle SigV4**

Add the SigV4 branch to the constructor:

```typescript
    if ('awsRegion' in config && config.awsRegion) {
      const baseURL = `https://bedrock-mantle.${config.awsRegion}.api.aws/v1`;

      if ('awsBedrockApiKey' in config && config.awsBedrockApiKey) {
        this.client = new OpenAI({ baseURL, apiKey: config.awsBedrockApiKey });
      } else if ('awsCredentials' in config && config.awsCredentials) {
        const { createSigV4Fetch } = require('./sigv4-fetch');
        const sigV4Fetch = createSigV4Fetch({
          region: config.awsRegion,
          credentials: config.awsCredentials,
          service: 'bedrock',
        });
        this.client = new OpenAI({ baseURL, apiKey: 'bedrock-sigv4', fetch: sigV4Fetch });
      }
    } else {
      this.client = new OpenAI({ apiKey: config.apiKey });
    }
```

- [ ] **Step 3: Run tests — expect PASS**

Run: `pnpm test __tests__/openai/openai.provider.test.ts`
Expected: All tests pass.

- [ ] **Step 4: Run full test suite and build**

Run: `pnpm test && pnpm build`
Expected: All tests pass, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add Bedrock SigV4 auth variant to OpenAI provider"
```

---

## Phase 3: Verification & Documentation

**Goal:** Verify the full integration works against a real bedrock-mantle endpoint (manual step), ensure exports are clean, and update documentation.

### Task 1: Verify Conversations API compatibility

- [ ] **Step 1: Manual test against bedrock-mantle**

Create a temporary test script `scripts/test-bedrock.ts`:

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: `https://bedrock-mantle.${process.env.AWS_REGION}.api.aws/v1`,
  apiKey: process.env.AWS_BEDROCK_API_KEY!,
});

// Test 1: Does conversations.create() work?
try {
  const conv = await client.conversations.create();
  console.log('✓ conversations.create() works:', conv.id);
} catch (e) {
  console.log('✗ conversations.create() failed:', (e as Error).message);
  console.log('  → May need fallback to previous_response_id chaining');
}

// Test 2: Stream a response
const stream = await client.responses.create({
  model: 'openai.gpt-oss-120b',
  input: [{ role: 'user', content: 'Say hello in one word.' }],
  stream: true,
});

for await (const event of stream) {
  console.log(event.type, event.type === 'response.output_text.delta' ? event.delta : '');
}
```

Run: `AWS_REGION=us-east-1 AWS_BEDROCK_API_KEY=<key> npx tsx scripts/test-bedrock.ts`

Expected: Both conversation creation and streaming work. If `conversations.create()` fails, proceed to Task 2.

### Task 2: Fallback — previous_response_id chaining (conditional)

> **Only implement this if Task 1 reveals that `conversations.create()` is NOT supported on bedrock-mantle.**

If Bedrock doesn't support the Conversations API, the provider needs a fallback path that:
1. Skips `conversations.create()` on the first turn
2. Uses the `response.id` from `response.created` event as the session ID
3. On subsequent turns, passes `previous_response_id: sessionId` instead of `conversation: { id: sessionId }`

**Files:**

- Modify: `src/openai/openai.provider.ts`

- [ ] **Step 1: Add a `useConversations` flag to the provider**

```typescript
  private readonly useConversations: boolean;

  constructor(config: OpenAIProviderConfig) {
    // ...existing code...
    // Bedrock may not support the Conversations API
    this.useConversations = !('awsRegion' in config && config.awsRegion);
  }
```

- [ ] **Step 2: Update `runStream` to conditionally use conversations or previous_response_id**

Replace the conversation resolution logic:

```typescript
    let conversationId: string | undefined;
    const createParams: Record<string, unknown> = { /* ...existing... */ };

    if (this.useConversations) {
      conversationId = params.sessionId
        ?? (await this.client.conversations.create()).id;
      createParams.conversation = { id: conversationId };
    } else if (params.sessionId) {
      createParams.previous_response_id = params.sessionId;
    }
```

And update how `sessionId` is captured from the response:

```typescript
    // In the response.created handler:
    case 'response.created': {
      acc.sessionId = event.response.id;
      acc.conversationId = event.response.conversation?.id;
      const resolvedSessionId = this.useConversations
        ? (acc.conversationId ?? acc.sessionId)
        : acc.sessionId;
      yield { type: 'stream-start', sessionId: resolvedSessionId };
      break;
    }
```

- [ ] **Step 3: Add tests for the fallback path**

```typescript
describe('Bedrock — previous_response_id fallback', () => {
  it('does not call conversations.create on Bedrock config', async () => {
    mockResponsesCreate.mockReturnValue(
      makeStream([
        { type: 'response.created', response: { id: 'resp_br_1', conversation: null } },
        { type: 'response.completed', response: { id: 'resp_br_1', output_text: 'hi', usage: {} } },
      ]),
    );

    await collectStream(
      await createOpenAIProvider(bedrockConfig).stream({
        messages: [{ role: 'user', content: 'hello' } as never],
      }),
    );

    expect(mockConversationsCreate).not.toHaveBeenCalled();
  });

  it('passes previous_response_id on session resume for Bedrock', async () => {
    mockResponsesCreate.mockReturnValue(
      makeStream([
        { type: 'response.created', response: { id: 'resp_br_2', conversation: null } },
        { type: 'response.completed', response: { id: 'resp_br_2', output_text: 'ok', usage: {} } },
      ]),
    );

    await collectStream(
      await createOpenAIProvider(bedrockConfig).stream({
        messages: [{ role: 'user', content: 'next' } as never],
        sessionId: 'resp_br_1',
      }),
    );

    expect(mockResponsesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ previous_response_id: 'resp_br_1' }),
    );
  });
});
```

- [ ] **Step 4: Run tests and build**

Run: `pnpm test && pnpm build`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add previous_response_id fallback for Bedrock (no Conversations API)"
```

### Task 3: Final verification

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
Expected: All tests pass.

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 3: Run build**

Run: `pnpm build`
Expected: Clean output.

- [ ] **Step 4: Run lint**

Run: `pnpm lint`
Expected: No errors.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore: verify Bedrock mantle integration"
```

---

## Usage Examples (after implementation)

### Bedrock API Key (simplest)

```typescript
import { thalamus } from '@novu/thalamus';

const runtime = thalamus.openai({
  awsRegion: 'us-east-1',
  awsBedrockApiKey: process.env.AWS_BEDROCK_API_KEY!,
  model: 'openai.gpt-oss-120b',
  instructions: 'You are a helpful assistant.',
});

const result = await runtime.stream({
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

### Bedrock SigV4 (IAM roles)

```typescript
import { thalamus } from '@novu/thalamus';

const runtime = thalamus.openai({
  awsRegion: 'us-east-1',
  awsCredentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    sessionToken: process.env.AWS_SESSION_TOKEN,
  },
  model: 'openai.gpt-oss-120b',
});
```

### Direct OpenAI (unchanged)

```typescript
import { thalamus } from '@novu/thalamus';

const runtime = thalamus.openai({
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-4o',
});
```

---

## Dependency Summary

| Package | Required for | Phase |
|---|---|---|
| `openai` (existing peer dep) | All OpenAI provider usage | — |
| `@aws-sdk/credential-providers` (new optional peer) | SigV4 credential resolution | 2 |
| `@smithy/signature-v4` (new optional peer) | Request signing | 2 |
| `@aws-crypto/sha256-js` (new optional peer) | SHA-256 for SigV4 | 2 |

Consumers using Bedrock API Key auth need zero new deps beyond `openai`.
Consumers using SigV4 install: `pnpm add @aws-sdk/credential-providers @smithy/signature-v4 @aws-crypto/sha256-js`

---

## Open Questions / Risks

1. **Conversations API on Bedrock:** AWS docs mention "stateful conversation management" but examples only show single-turn. Phase 3 Task 1 tests this. If unsupported, Task 2 provides the fallback.
2. **Model ID discovery:** Bedrock model IDs differ from OpenAI's (`openai.gpt-oss-120b` vs `gpt-4o`). Users must pass the correct model ID for their endpoint. We don't validate or map model names.
3. **Rate limiting headers:** Bedrock may return different rate-limit headers than OpenAI. The existing `mapError` function uses generic patterns (`rate_limit_exceeded`) — may need Bedrock-specific status codes added if errors differ.
