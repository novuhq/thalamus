# AWS Claude Platform Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Claude Platform on AWS authentication support to the existing Anthropic provider, plus a typed `SessionExpiredError` for clean session-timeout handling.

**Architecture:** Auth variant within the existing `createAnthropicProvider()`. The config type becomes a discriminated union — callers pass either `apiKey` (direct Anthropic API) or `awsRegion` (Claude Platform on AWS). The constructor picks `Anthropic` or `AnthropicAws` accordingly. A new `SessionExpiredError` maps 404/410 responses on session resume to a typed, retryable error. No new providers, no new subpath exports — the API surface is identical, only authentication differs.

**Tech Stack:** TypeScript (ES2022), vitest, `@anthropic-ai/sdk`, `@anthropic-ai/aws-sdk` (peer dep, already declared).

**Approach:** Three phases. Phase 1 refactors the config type to a discriminated union and adds the `AnthropicAws` client path. Phase 2 adds `SessionExpiredError` with detection logic in the Anthropic provider. Phase 3 adds tests and exports.

**Dependencies:** `@anthropic-ai/aws-sdk` is already an optional peer dep and dev dep. No new packages needed.

---

## File Structure (changes relative to current codebase)

```
src/
  errors.ts                        # Phase 2: add SessionExpiredError
  anthropic/
    anthropic.provider.ts          # Phase 1: discriminated union config, AnthropicAws client
                                   # Phase 2: detect session expiry in runStream
    index.ts                       # No changes needed (re-exports provider + transformer)

__tests__/
  anthropic/
    anthropic.provider.test.ts     # Phase 1: new tests for AWS config path
                                   # Phase 2: new tests for SessionExpiredError
```

---

## Phase 1: AWS Auth Variant

**Goal:** `createAnthropicProvider({ agentId, environmentId, awsRegion: 'us-east-1' })` creates a provider that uses `AnthropicAws` for SigV4 authentication. Existing `apiKey` config continues to work unchanged.

### Task 1: Write failing tests for AWS config path

**Files:**

- Modify: `__tests__/anthropic/anthropic.provider.test.ts`

- [ ] **Step 1: Add mock for `@anthropic-ai/aws-sdk`**

Add the mock at the top of `__tests__/anthropic/anthropic.provider.test.ts`, after the existing `vi.mock('@anthropic-ai/sdk', ...)` block:

```typescript
vi.mock('@anthropic-ai/aws-sdk', () => {
  const MockAnthropicAws = function (config: Record<string, unknown>) {
    (this as any)._awsConfig = config;
    return {
      beta: {
        sessions: {
          create: mockCreate,
          events: { stream: mockSseStream, send: mockSend },
        },
      },
      _awsConfig: config,
    };
  };
  return { AnthropicAws: MockAnthropicAws };
});
```

- [ ] **Step 2: Add test cases for AWS config**

Append this describe block to `__tests__/anthropic/anthropic.provider.test.ts`:

```typescript
const awsConfig = { agentId: 'agent_abc', environmentId: 'env_xyz', awsRegion: 'us-east-1' };

describe('AWS auth variant', () => {
  it('creates provider with awsRegion config', () => {
    const rt = createAnthropicProvider(awsConfig);
    expect(rt.provider).toBe('anthropic');
    expect(rt.runtimeId).toBe('agent_abc');
  });

  it('streams successfully via AnthropicAws client', async () => {
    mockCreate.mockResolvedValue({ id: 'sess_aws' });
    mockSseStream.mockResolvedValue(
      mockSse([
        { type: 'agent.message', id: 'evt_1', content: [{ type: 'text', text: 'Hello from AWS!' }] },
        { type: 'session.status_idle', id: 'evt_2', stop_reason: { type: 'end_turn' } },
      ]),
    );
    mockSend.mockResolvedValue({});

    const rt = createAnthropicProvider(awsConfig);
    const result = await rt.stream({
      messages: [{ role: 'user', content: 'Hi' } as never],
    });

    const parts = [];
    for await (const part of result.stream) parts.push(part);

    expect(parts.find((p) => p.type === 'text-delta')).toMatchObject({ text: 'Hello from AWS!' });
    const response = await result.response;
    expect(response.content).toBe('Hello from AWS!');
    expect(response.sessionId).toBe('sess_aws');
  });

  it('passes awsWorkspaceId when provided', () => {
    const rt = createAnthropicProvider({
      ...awsConfig,
      awsWorkspaceId: 'wrkspc_abc',
    });
    expect(rt.provider).toBe('anthropic');
  });
});
```

- [ ] **Step 3: Run tests — expect FAIL**

Run: `pnpm test __tests__/anthropic/anthropic.provider.test.ts`
Expected: FAIL — `createAnthropicProvider` does not accept `awsRegion` (TypeScript error) and `@anthropic-ai/aws-sdk` is not imported.

### Task 2: Refactor config type to discriminated union and add AnthropicAws path

**Files:**

- Modify: `src/anthropic/anthropic.provider.ts`

- [ ] **Step 1: Update `AnthropicProviderConfig` to a discriminated union**

In `src/anthropic/anthropic.provider.ts`, replace the existing `AnthropicProviderConfig` interface (line 168–172):

```typescript
export type AnthropicProviderConfig = {
  agentId: string;
  environmentId: string;
} & (
  | { apiKey: string; awsRegion?: never; awsWorkspaceId?: never }
  | { awsRegion: string; awsWorkspaceId?: string; apiKey?: never }
);
```

- [ ] **Step 2: Update the constructor to handle both auth modes**

Replace the constructor in the `AnthropicProvider` class (lines 182–187):

```typescript
  constructor(config: AnthropicProviderConfig) {
    this.agentId = config.agentId;
    this.environmentId = config.environmentId;
    this.runtimeId = config.agentId;

    if ('awsRegion' in config && config.awsRegion) {
      const { AnthropicAws } = require('@anthropic-ai/aws-sdk');
      this.client = new AnthropicAws({
        awsRegion: config.awsRegion,
        ...(config.awsWorkspaceId ? { awsWorkspaceId: config.awsWorkspaceId } : {}),
      });
    } else {
      this.client = new Anthropic({ apiKey: config.apiKey });
    }
  }
```

- [ ] **Step 3: Run tests — expect PASS**

Run: `pnpm test __tests__/anthropic/anthropic.provider.test.ts`
Expected: All tests pass — existing `apiKey` tests unchanged, new AWS tests pass.

- [ ] **Step 4: Run full test suite and build**

Run: `pnpm test && pnpm build`
Expected: All tests pass, build succeeds. No breakage in OpenAI tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add Claude Platform on AWS auth variant to Anthropic provider"
```

---

## Phase 2: SessionExpiredError

**Goal:** When the Anthropic provider tries to resume a session that has expired (404/410), it throws a typed `SessionExpiredError` with `isRetryable: true` so consumers can catch it, clear their stored session ID, and retry with history replay.

### Task 1: Add SessionExpiredError class

**Files:**

- Modify: `src/errors.ts`

- [ ] **Step 1: Add SessionExpiredError to errors.ts**

Append to `src/errors.ts`:

```typescript
export class SessionExpiredError extends ThalamusError {
  readonly sessionId: string;

  constructor(message: string, options: { provider: string; sessionId: string; cause?: unknown }) {
    super(message, { ...options, isRetryable: true });
    this.name = 'SessionExpiredError';
    this.sessionId = options.sessionId;
  }
}
```

- [ ] **Step 2: Run existing tests — still PASS**

Run: `pnpm test`
Expected: All existing tests pass. Adding a new class is additive.

### Task 2: Write failing tests for session expiry detection

**Files:**

- Modify: `__tests__/anthropic/anthropic.provider.test.ts`

- [ ] **Step 1: Add test for SessionExpiredError on 404 during session resume**

Add import at the top of the test file, alongside the existing `ThalamusError` import:

```typescript
import { ThalamusError, SessionExpiredError } from '../../src/errors.js';
```

Append this describe block:

```typescript
describe('session expiry detection', () => {
  it('throws SessionExpiredError when SSE stream returns 404 on resume', async () => {
    const notFoundError = Object.assign(new Error('Not Found'), { status: 404 });
    mockSseStream.mockRejectedValue(notFoundError);

    const result = await createAnthropicProvider(config).stream({
      messages: [{ role: 'user', content: 'hello' } as never],
      sessionId: 'sess_expired',
    });
    result.response.catch(() => {});

    const parts = [];
    for await (const p of result.stream) parts.push(p);

    const errPart = parts.find((p) => p.type === 'error');
    expect(errPart).toBeDefined();
    expect((errPart as any).error).toBeInstanceOf(SessionExpiredError);
    expect((errPart as any).error.sessionId).toBe('sess_expired');
    expect((errPart as any).error.isRetryable).toBe(true);
  });

  it('throws SessionExpiredError when SSE stream returns 410 on resume', async () => {
    const goneError = Object.assign(new Error('Gone'), { status: 410 });
    mockSseStream.mockRejectedValue(goneError);

    const result = await createAnthropicProvider(config).stream({
      messages: [{ role: 'user', content: 'hello' } as never],
      sessionId: 'sess_gone',
    });
    result.response.catch(() => {});

    const parts = [];
    for await (const p of result.stream) parts.push(p);

    const errPart = parts.find((p) => p.type === 'error');
    expect(errPart).toBeDefined();
    expect((errPart as any).error).toBeInstanceOf(SessionExpiredError);
    expect((errPart as any).error.sessionId).toBe('sess_gone');
  });

  it('does NOT throw SessionExpiredError for other errors', async () => {
    const serverError = Object.assign(new Error('Internal Server Error'), { status: 500 });
    mockSseStream.mockRejectedValue(serverError);

    const result = await createAnthropicProvider(config).stream({
      messages: [{ role: 'user', content: 'hello' } as never],
      sessionId: 'sess_other',
    });
    result.response.catch(() => {});

    const parts = [];
    for await (const p of result.stream) parts.push(p);

    const errPart = parts.find((p) => p.type === 'error');
    expect(errPart).toBeDefined();
    expect((errPart as any).error).not.toBeInstanceOf(SessionExpiredError);
  });

  it('does NOT throw SessionExpiredError for 404 on new session (no sessionId)', async () => {
    const notFoundError = Object.assign(new Error('Not Found'), { status: 404 });
    mockCreate.mockRejectedValue(notFoundError);

    const result = await createAnthropicProvider(config).stream({
      messages: [{ role: 'user', content: 'hello' } as never],
    });
    result.response.catch(() => {});

    const parts = [];
    for await (const p of result.stream) parts.push(p);

    const errPart = parts.find((p) => p.type === 'error');
    expect(errPart).toBeDefined();
    expect((errPart as any).error).not.toBeInstanceOf(SessionExpiredError);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `pnpm test __tests__/anthropic/anthropic.provider.test.ts`
Expected: FAIL — `SessionExpiredError` is not thrown; generic `ThalamusError` is thrown instead.

### Task 3: Detect session expiry in Anthropic provider

**Files:**

- Modify: `src/anthropic/anthropic.provider.ts`

- [ ] **Step 1: Import SessionExpiredError**

In `src/anthropic/anthropic.provider.ts`, add `SessionExpiredError` to the import from `../errors`:

```typescript
import { ThalamusError, SessionExpiredError } from '../errors';
```

- [ ] **Step 2: Add session expiry detection in the catch block of `runStream`**

Replace the `catch` block in `runStream` (currently lines 231–235):

```typescript
    } catch (err) {
      const isSessionExpired = params.sessionId
        && err instanceof Error
        && 'status' in err
        && ((err as any).status === 404 || (err as any).status === 410);

      const error = isSessionExpired
        ? new SessionExpiredError(
            `Session ${params.sessionId} has expired or been archived`,
            { provider: ANTHROPIC, sessionId: params.sessionId!, cause: err },
          )
        : err instanceof ThalamusError
          ? err
          : new ThalamusError(String(err), { provider: ANTHROPIC, isRetryable: false, cause: err });

      yield { type: 'error', error };
      rejectResponse(error);
    }
```

- [ ] **Step 3: Run tests — expect PASS**

Run: `pnpm test __tests__/anthropic/anthropic.provider.test.ts`
Expected: All tests pass including the new session expiry tests.

- [ ] **Step 4: Run full test suite and build**

Run: `pnpm test && pnpm build`
Expected: All tests pass, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add SessionExpiredError for expired session detection"
```

---

## Phase 3: Exports and Final Verification

**Goal:** Ensure `SessionExpiredError` is exported from the package root, verify the build, and run the full suite.

### Task 1: Verify exports

**Files:**

- Check: `src/errors.ts` (already exports `SessionExpiredError`)
- Check: `src/index.ts` (already re-exports `./errors` via `export * from './errors'`)

- [ ] **Step 1: Verify SessionExpiredError is accessible from root import**

The root `src/index.ts` already has `export * from './errors'`, so `SessionExpiredError` is automatically exported. No changes needed.

Verify by running:

Run: `pnpm build && node -e "const t = require('./dist/index.cjs'); console.log(typeof t.SessionExpiredError)"`
Expected: `function`

### Task 2: Final build and test verification

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
Expected: All tests pass.

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 3: Run build**

Run: `pnpm build`
Expected: `dist/` output with no errors.

- [ ] **Step 4: Run lint**

Run: `pnpm lint`
Expected: No errors.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore: verify AWS auth and SessionExpiredError exports"
```
