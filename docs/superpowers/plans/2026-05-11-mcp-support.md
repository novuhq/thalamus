# Server-Side MCP Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add server-side MCP (Model Context Protocol) support to `@novu/thalamus` — shared types for MCP server configuration, enriched stream events that distinguish MCP tool calls from builtin/custom tools, explicit session lifecycle with per-session MCP auth, and a unified approval flow.

**Architecture:** MCP server *declaration* lives on the provider factory config (actively used by OpenAI, informational for Anthropic/Bedrock where servers are pre-configured). MCP *auth* lives on a new `createSession()` method for per-tenant credential isolation. Stream events gain a `source` field to distinguish MCP/builtin/custom tool activity. The MCP approval flow reuses the existing `requires-action` + `actionsRequired` pattern.

**Tech Stack:** TypeScript (ES2022), vitest, Biome, `@anthropic-ai/sdk` (peer dep).

**Approach:** Four phases. Phase 1 adds shared MCP types and enriches Anthropic stream events. Phase 2 adds `createSession()` to the Provider interface with Anthropic vault integration. Phase 3 adds the MCP approval/tool-result round-trip. Phase 4 (deferred) wires up OpenAI MCP when that provider is built.

**Dependencies:** OpenAI and Bedrock providers are currently stubs (`export {}`). Phases 1–3 work against the existing Anthropic provider. Phase 4 requires the OpenAI provider from the [thalamus package plan](./2026-05-11-thalamus-package.md) Phase 3.

---

## File Structure (changes relative to current codebase)

```
src/
  types.ts                        # Phase 1: add McpServerConfig, ToolSource, McpToolDef, etc.
                                  # Phase 2: add SessionOptions, McpAuthConfig
                                  # Phase 3: add ToolResult, extend ActionRequired
  anthropic/
    anthropic.provider.ts         # Phase 1: enrich tool events with source
                                  # Phase 2: implement createSession with vault_ids
                                  # Phase 3: handle tool_confirmation send-back
  openai/
    openai.provider.ts            # Phase 4 (deferred): McpServerConfig → tools array

__tests__/
  anthropic/
    anthropic.provider.test.ts    # Phase 1–3: new test cases for MCP source, createSession, toolResults
```

---

## Phase 1: Shared MCP Types + Anthropic Stream Enrichment

**Goal:** `tool-use-start` and `tool-use-result` stream events carry a `source` field that tells consumers whether a tool call came from MCP, a builtin agent tool, or a custom (client-side) tool. New shared types define MCP server configuration for use by any provider.

**What changes:**
- `StreamPart` tool events gain an optional `source` field
- New types: `McpServerConfig`, `McpApprovalPolicy`, `ToolSource`, `McpToolDef`
- New stream part: `mcp-tools-discovered`
- Anthropic provider's `mapEvent` function emits `source` on MCP and builtin tool events
- Note: `mcp-tools-discovered` is defined in types but not emitted by Anthropic — Anthropic's tool discovery happens at agent creation time, not during streaming. This event will be emitted by the OpenAI provider (Phase 4) which gets `mcp_list_tools` in the response.

### Task 1: Add shared MCP types to types.ts

**Files:**

- Modify: `src/types.ts`

- [ ] **Step 1: Add MCP configuration types**

Append these types after the existing `BEDROCK` constant at the bottom of `src/types.ts`:

```typescript
// --- MCP Server Configuration ---

export type McpApprovalPolicy =
  | 'always'
  | 'never'
  | { except: string[] };

export interface McpServerConfig {
  name: string;
  url: string;
  allowedTools?: string[];
  approvalPolicy?: McpApprovalPolicy;
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export type ToolSource =
  | { type: 'builtin' }
  | { type: 'custom' }
  | { type: 'mcp'; serverName: string };
```

- [ ] **Step 2: Add `source` to tool-use stream parts and add `mcp-tools-discovered`**

Replace the `StreamPart` type union in `src/types.ts`:

```typescript
export type StreamPart =
  | { type: 'text-delta'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool-use-start'; toolName: string; toolUseId: string; input?: Record<string, unknown>; source?: ToolSource }
  | { type: 'tool-use-result'; toolUseId: string; output?: string; source?: ToolSource }
  | { type: 'mcp-tools-discovered'; serverName: string; tools: McpToolDef[] }
  | { type: 'status-change'; status: AgentStatus }
  | { type: 'stream-start'; sessionId?: string }
  | { type: 'finish'; response: Response }
  | { type: 'error'; error: Error }
  | { type: 'provider-event'; provider: string; event: string; data: Record<string, unknown> };
```

- [ ] **Step 3: Run existing tests — still PASS**

Run: `pnpm test`
Expected: All existing tests pass. `source` is optional so no breakage.

- [ ] **Step 4: Verify build**

Run: `pnpm build`
Expected: No errors.

### Task 2: Write failing tests for enriched Anthropic MCP stream events

**Files:**

- Modify: `__tests__/anthropic/anthropic.provider.test.ts`

- [ ] **Step 1: Add test for MCP tool events carrying source**

Append this describe block to `__tests__/anthropic/anthropic.provider.test.ts`:

```typescript
describe('MCP tool events carry source', () => {
  it('emits tool-use-start with source.type = mcp for agent.mcp_tool_use', async () => {
    mockCreate.mockResolvedValue({ id: 'sess_mcp' });
    mockSseStream.mockResolvedValue(
      mockSse([
        {
          type: 'agent.mcp_tool_use',
          id: 'mcp_tu_1',
          name: 'search_issues',
          input: { query: 'bug' },
          server_name: 'linear',
        },
        {
          type: 'agent.mcp_tool_result',
          id: 'mcp_tr_1',
          mcp_tool_use_id: 'mcp_tu_1',
          server_name: 'linear',
          content: [{ type: 'text', text: '3 issues found' }],
        },
        { type: 'session.status_idle', id: 'evt_idle', stop_reason: { type: 'end_turn' } },
      ]),
    );
    mockSend.mockResolvedValue({});

    const result = await createAnthropicProvider(config).stream({
      message: { role: 'user', content: 'find bugs' } as never,
    });

    const parts = [];
    for await (const p of result.stream) parts.push(p);

    const toolStart = parts.find((p) => p.type === 'tool-use-start');
    expect(toolStart).toMatchObject({
      type: 'tool-use-start',
      toolName: 'search_issues',
      toolUseId: 'mcp_tu_1',
      source: { type: 'mcp', serverName: 'linear' },
    });

    const toolResult = parts.find((p) => p.type === 'tool-use-result');
    expect(toolResult).toMatchObject({
      type: 'tool-use-result',
      toolUseId: 'mcp_tu_1',
      output: '3 issues found',
      source: { type: 'mcp', serverName: 'linear' },
    });
  });
});

describe('builtin tool events carry source', () => {
  it('emits tool-use-start with source.type = builtin for agent.tool_use', async () => {
    mockCreate.mockResolvedValue({ id: 'sess_bt' });
    mockSseStream.mockResolvedValue(
      mockSse([
        {
          type: 'agent.tool_use',
          id: 'tu_1',
          name: 'bash',
          input: { command: 'ls' },
        },
        {
          type: 'agent.tool_result',
          id: 'tr_1',
          tool_use_id: 'tu_1',
          content: [{ type: 'text', text: 'file.txt' }],
        },
        { type: 'session.status_idle', id: 'evt_idle', stop_reason: { type: 'end_turn' } },
      ]),
    );
    mockSend.mockResolvedValue({});

    const result = await createAnthropicProvider(config).stream({
      message: { role: 'user', content: 'list files' } as never,
    });

    const parts = [];
    for await (const p of result.stream) parts.push(p);

    const toolStart = parts.find((p) => p.type === 'tool-use-start');
    expect(toolStart).toMatchObject({
      source: { type: 'builtin' },
    });

    const toolResult = parts.find((p) => p.type === 'tool-use-result');
    expect(toolResult).toMatchObject({
      source: { type: 'builtin' },
    });
  });
});
```

- [ ] **Step 2: Run new tests — expect FAIL**

Run: `pnpm test __tests__/anthropic/anthropic.provider.test.ts`
Expected: FAIL — the `source` field is missing from emitted events.

### Task 3: Enrich Anthropic provider mapEvent with source

**Files:**

- Modify: `src/anthropic/anthropic.provider.ts`

- [ ] **Step 1: Update builtin tool_use/tool_result cases**

In `src/anthropic/anthropic.provider.ts`, in the `mapEvent` function, replace the `agent.tool_use` case (currently lines 83–86):

```typescript
    case 'agent.tool_use': {
      const e = event as BetaManagedAgentsAgentToolUseEvent;
      yield { type: 'tool-use-start', toolName: e.name, toolUseId: e.id, input: e.input, source: { type: 'builtin' } };
      break;
    }
```

Replace the `agent.tool_result` case (currently lines 88–92):

```typescript
    case 'agent.tool_result': {
      const e = event as BetaManagedAgentsAgentToolResultEvent;
      const output = e.content?.find((b) => b.type === 'text');
      yield { type: 'tool-use-result', toolUseId: e.tool_use_id, output: output?.type === 'text' ? output.text : undefined, source: { type: 'builtin' } };
      break;
    }
```

- [ ] **Step 2: Update MCP tool_use/tool_result cases**

Replace the `agent.mcp_tool_use` case (currently lines 94–97):

```typescript
    case 'agent.mcp_tool_use': {
      const e = event as BetaManagedAgentsAgentMCPToolUseEvent;
      const serverName = (e as any).server_name ?? 'unknown';
      yield { type: 'tool-use-start', toolName: e.name, toolUseId: e.id, input: e.input, source: { type: 'mcp', serverName } };
      break;
    }
```

Replace the `agent.mcp_tool_result` case (currently lines 99–103):

```typescript
    case 'agent.mcp_tool_result': {
      const e = event as BetaManagedAgentsAgentMCPToolResultEvent;
      const serverName = (e as any).server_name ?? 'unknown';
      const output = e.content?.find((b) => b.type === 'text');
      yield { type: 'tool-use-result', toolUseId: e.mcp_tool_use_id, output: output?.type === 'text' ? output.text : undefined, source: { type: 'mcp', serverName } };
      break;
    }
```

- [ ] **Step 3: Run tests — expect PASS**

Run: `pnpm test __tests__/anthropic/anthropic.provider.test.ts`
Expected: All tests pass including the new MCP source tests.

- [ ] **Step 4: Run full test suite and build**

Run: `pnpm test && pnpm build`
Expected: All tests pass, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add shared MCP types and enrich Anthropic stream events with tool source"
```

---

## Phase 2: Explicit Session Lifecycle with MCP Auth

**Goal:** `provider.createSession()` returns a session ID. For Anthropic, it accepts `vault_ids` for MCP credential injection. This replaces the implicit session creation that currently happens inside `stream()`.

**What changes:**
- `Provider` interface gains `createSession(options?)` method
- New types: `SessionOptions`, `McpAuthConfig`
- Anthropic provider implements `createSession` with `vault_ids` and `resources` pass-through
- `stream()` requires `sessionId` when `createSession` is available (but remains backwards-compatible — absent `sessionId` still auto-creates)

### Task 1: Add session types to types.ts

**Files:**

- Modify: `src/types.ts`

- [ ] **Step 1: Add SessionOptions and McpAuthConfig types**

Append after the `ToolSource` type in `src/types.ts`:

```typescript
// --- Session Configuration ---

export interface McpAuthConfig {
  authorization: string;
}

export interface SessionOptions {
  mcpAuth?: Record<string, McpAuthConfig>;
  providerSessionOptions?: Record<string, unknown>;
}
```

- [ ] **Step 2: Add createSession to Provider interface**

Replace the `Provider` interface in `src/types.ts`:

```typescript
export interface Provider {
  readonly provider: string;
  readonly runtimeId: string;
  createSession?(options?: SessionOptions): Promise<string>;
  send(params: RequestParams): Promise<Response>;
  stream(params: RequestParams): Promise<StreamResult>;
  endSession?(sessionId: string): Promise<void>;
  validate?(): Promise<boolean>;
}
```

- [ ] **Step 3: Run existing tests — still PASS**

Run: `pnpm test`
Expected: All tests pass. `createSession` is optional (`?`) so no breakage.

### Task 2: Write failing tests for Anthropic createSession

**Files:**

- Modify: `__tests__/anthropic/anthropic.provider.test.ts`

- [ ] **Step 1: Add mock for vault operations**

Add these mock functions after the existing mock declarations (after `const mockArchive = vi.fn();`, currently line 18):

```typescript
const mockVaultCreate = vi.fn();
const mockCredentialCreate = vi.fn();
```

Update the mock factory (the `MockAnthropic` function inside `vi.mock`) to include vault operations. Replace the entire `vi.mock('@anthropic-ai/sdk', ...)` block:

```typescript
vi.mock('@anthropic-ai/sdk', () => {
  const MockAnthropic = function () {
    return {
      beta: {
        sessions: {
          create: mockCreate,
          archive: mockArchive,
          events: { stream: mockSseStream, send: mockSend },
        },
        vaults: {
          create: mockVaultCreate,
          credentials: { create: mockCredentialCreate },
        },
      },
    };
  };
  return { default: MockAnthropic };
});
```

- [ ] **Step 2: Add createSession test cases**

Append this describe block to the test file:

```typescript
describe('createSession', () => {
  it('creates a session and returns the session ID', async () => {
    mockCreate.mockResolvedValue({ id: 'sess_new_cs' });

    const provider = createAnthropicProvider(config);
    const sessionId = await provider.createSession!();

    expect(sessionId).toBe('sess_new_cs');
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'agent_abc',
        environment_id: 'env_xyz',
      }),
    );
  });

  it('creates a vault and passes vault_ids when mcpAuth is provided', async () => {
    mockVaultCreate.mockResolvedValue({ id: 'vlt_123' });
    mockCredentialCreate.mockResolvedValue({});
    mockCreate.mockResolvedValue({ id: 'sess_vlt' });

    const provider = createAnthropicProvider(config);
    const sessionId = await provider.createSession!({
      mcpAuth: {
        linear: { authorization: 'Bearer eyJ...' },
      },
    });

    expect(sessionId).toBe('sess_vlt');
    expect(mockVaultCreate).toHaveBeenCalledOnce();
    expect(mockCredentialCreate).toHaveBeenCalledOnce();
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        vault_ids: ['vlt_123'],
      }),
    );
  });

  it('passes providerSessionOptions through to sessions.create', async () => {
    mockCreate.mockResolvedValue({ id: 'sess_opts' });

    const provider = createAnthropicProvider(config);
    await provider.createSession!({
      providerSessionOptions: {
        resources: [{ type: 'github_repository', url: 'https://github.com/org/repo' }],
      },
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        resources: [{ type: 'github_repository', url: 'https://github.com/org/repo' }],
      }),
    );
  });
});
```

- [ ] **Step 3: Run new tests — expect FAIL**

Run: `pnpm test __tests__/anthropic/anthropic.provider.test.ts`
Expected: FAIL — `provider.createSession` does not exist yet on the returned object.

### Task 3: Implement createSession on Anthropic provider

**Files:**

- Modify: `src/anthropic/anthropic.provider.ts`

- [ ] **Step 1: Import SessionOptions**

Add `SessionOptions` to the imports from `../types.js` in `src/anthropic/anthropic.provider.ts`:

```typescript
import {
  ANTHROPIC,
  type ActionRequired,
  type RequestParams,
  type Provider,
  type Response,
  type SessionOptions,
  type StreamPart,
  type StreamResult,
  type Usage,
} from '../types.js';
```

- [ ] **Step 2: Implement createSession method**

Replace the existing `createSession` private method (currently lines 217–224) with a public method. Add this method to the `AnthropicProvider` class, replacing the existing private `createSession`:

```typescript
  async createSession(options?: SessionOptions): Promise<string> {
    const createParams: Record<string, unknown> = {
      agent: this.agentId,
      environment_id: this.environmentId,
    };

    if (options?.mcpAuth) {
      const vault = await (this.client.beta as any).vaults.create({
        name: `thalamus-${Date.now()}`,
      });
      for (const [serverName, auth] of Object.entries(options.mcpAuth)) {
        await (this.client.beta as any).vaults.credentials.create(vault.id, {
          display_name: serverName,
          auth: {
            type: 'mcp_oauth',
            mcp_server_url: this.resolveMcpServerUrl(serverName),
            access_token: auth.authorization.replace(/^Bearer\s+/i, ''),
          },
        });
      }
      createParams.vault_ids = [vault.id];
    }

    if (options?.providerSessionOptions) {
      Object.assign(createParams, options.providerSessionOptions);
    }

    const session = await this.client.beta.sessions.create(createParams as any);
    return session.id;
  }

  private resolveMcpServerUrl(serverName: string): string {
    const server = this.mcpServers?.find((s) => s.name === serverName);
    if (!server) {
      throw new ThalamusError(
        `No MCP server configured with name "${serverName}". Add it to mcpServers in provider config.`,
        { provider: ANTHROPIC, isRetryable: false },
      );
    }
    return server.url;
  }
```

- [ ] **Step 3: Add mcpServers to constructor config**

Update the constructor to accept and store `mcpServers`. Replace the constructor and class field declarations:

```typescript
class AnthropicProvider implements Provider {
  readonly provider = ANTHROPIC;
  readonly runtimeId: string;

  private readonly client: Anthropic;
  private readonly agentId: string;
  private readonly environmentId: string;
  private readonly mcpServers?: McpServerConfig[];

  constructor(config: { apiKey: string; agentId: string; environmentId: string; mcpServers?: McpServerConfig[] }) {
    this.agentId = config.agentId;
    this.environmentId = config.environmentId;
    this.runtimeId = config.agentId;
    this.mcpServers = config.mcpServers;
    this.client = new Anthropic({ apiKey: config.apiKey });
  }
```

Add `McpServerConfig` to the imports from `../types.js`:

```typescript
import {
  ANTHROPIC,
  type ActionRequired,
  type McpServerConfig,
  type RequestParams,
  type Provider,
  type Response,
  type SessionOptions,
  type StreamPart,
  type StreamResult,
  type Usage,
} from '../types.js';
```

- [ ] **Step 4: Update runStream to use createSession for new sessions**

In `runStream`, replace the session creation line (currently `const sessionId = params.sessionId ?? (await this.createSession());`):

```typescript
      const sessionId = params.sessionId ?? (await this.createSession());
```

This line stays the same — `createSession()` without options creates a basic session, which is the correct fallback for `stream()` when no explicit session was created.

- [ ] **Step 5: Update the factory function signature**

Replace the `createAnthropicProvider` export at the bottom of the file:

```typescript
export function createAnthropicProvider(config: {
  apiKey: string;
  agentId: string;
  environmentId: string;
  mcpServers?: McpServerConfig[];
}): Provider {
  return new AnthropicProvider(config);
}
```

- [ ] **Step 6: Run tests — expect PASS**

Run: `pnpm test __tests__/anthropic/anthropic.provider.test.ts`
Expected: All tests pass including the new createSession tests.

- [ ] **Step 7: Run full test suite and build**

Run: `pnpm test && pnpm build`
Expected: All tests pass, build succeeds.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add createSession with MCP auth (vault) support for Anthropic"
```

---

## Phase 3: MCP Approval Flow + Tool Results

**Goal:** When a provider requires approval before calling an MCP tool, the stream finishes with `finishReason: 'requires-action'` and `actionsRequired` entries of type `mcp-approval`. The consumer approves/denies, then resumes via `toolResults` on the next `stream()` call.

**What changes:**
- `ActionRequired.type` union extended with `'mcp-approval'`
- `ActionRequired` gains optional `serverName` field
- New `ToolResult` type and `toolResults` field on `RequestParams`
- Anthropic provider sends `user.custom_tool_result` or `user.tool_confirmation` events when `toolResults` is present

### Task 1: Add ToolResult types

**Files:**

- Modify: `src/types.ts`

- [ ] **Step 1: Add ToolResult type**

Append after `McpAuthConfig` in `src/types.ts`:

```typescript
// --- Tool Results (for client-side tool execution and MCP approval) ---

export interface ToolResult {
  toolUseId: string;
  output?: string;
  isError?: boolean;
  approved?: boolean;
}
```

- [ ] **Step 2: Extend ActionRequired with mcp-approval and serverName**

Replace the `ActionRequired` interface in `src/types.ts`:

```typescript
export interface ActionRequired {
  type: 'tool-confirmation' | 'mcp-approval';
  toolUseId: string;
  toolName: string;
  serverName?: string;
  input?: Record<string, unknown>;
}
```

- [ ] **Step 3: Add toolResults to RequestParams**

Replace the `RequestParams` interface in `src/types.ts`:

```typescript
export interface RequestParams {
  /** The user's message for this turn. Always role: user. */
  message: Message;
  /** Opaque session identifier returned by a prior response. Absent means start a new session. */
  sessionId?: string;
  /** Prior conversation for session recovery when sessionId is absent. Provider ignores when sessionId is present. */
  history?: Message[];
  /** Results from client-side tool execution or MCP approval responses. */
  toolResults?: ToolResult[];
  /** Pass-through options forwarded directly to the underlying provider SDK call. */
  providerOptions?: Record<string, unknown>;
}
```

- [ ] **Step 4: Run existing tests — still PASS**

Run: `pnpm test`
Expected: All tests pass. All additions are optional/additive.

### Task 2: Write failing tests for Anthropic tool results

**Files:**

- Modify: `__tests__/anthropic/anthropic.provider.test.ts`

- [ ] **Step 1: Add test for sending custom tool results**

Append this describe block:

```typescript
describe('toolResults — custom tool round-trip', () => {
  it('sends user.custom_tool_result events when toolResults are provided', async () => {
    mockSseStream.mockResolvedValue(
      mockSse([
        { type: 'agent.message', id: 'evt_1', content: [{ type: 'text', text: 'Done with tool.' }] },
        { type: 'session.status_idle', id: 'evt_2', stop_reason: { type: 'end_turn' } },
      ]),
    );
    mockSend.mockResolvedValue({});

    const result = await createAnthropicProvider(config).stream({
      message: { role: 'user', content: 'continue' } as never,
      sessionId: 'sess_existing',
      toolResults: [
        { toolUseId: 'ctu_abc', output: '{"temp": 72}' },
      ],
    });

    await collectStream(result);

    const sendCalls = mockSend.mock.calls;
    expect(sendCalls).toHaveLength(1);

    const sentEvents = sendCalls[0][1].events;
    expect(sentEvents).toContainEqual(
      expect.objectContaining({
        type: 'user.custom_tool_result',
        tool_use_id: 'ctu_abc',
        content: [{ type: 'text', text: '{"temp": 72}' }],
      }),
    );
  });
});

describe('toolResults — MCP approval round-trip', () => {
  it('sends user.tool_confirmation events when toolResults have approved field', async () => {
    mockSseStream.mockResolvedValue(
      mockSse([
        { type: 'agent.message', id: 'evt_1', content: [{ type: 'text', text: 'Approved and done.' }] },
        { type: 'session.status_idle', id: 'evt_2', stop_reason: { type: 'end_turn' } },
      ]),
    );
    mockSend.mockResolvedValue({});

    const result = await createAnthropicProvider(config).stream({
      message: { role: 'user', content: 'approve it' } as never,
      sessionId: 'sess_existing',
      toolResults: [
        { toolUseId: 'mcp_tu_1', approved: true },
      ],
    });

    await collectStream(result);

    const sentEvents = mockSend.mock.calls[0][1].events;
    expect(sentEvents).toContainEqual(
      expect.objectContaining({
        type: 'user.tool_confirmation',
        tool_use_id: 'mcp_tu_1',
        result: 'allow',
      }),
    );
  });

  it('sends deny with message when approved is false and output is provided', async () => {
    mockSseStream.mockResolvedValue(
      mockSse([
        { type: 'agent.message', id: 'evt_1', content: [{ type: 'text', text: 'Denied.' }] },
        { type: 'session.status_idle', id: 'evt_2', stop_reason: { type: 'end_turn' } },
      ]),
    );
    mockSend.mockResolvedValue({});

    const result = await createAnthropicProvider(config).stream({
      message: { role: 'user', content: 'deny' } as never,
      sessionId: 'sess_existing',
      toolResults: [
        { toolUseId: 'mcp_tu_2', approved: false, output: 'Use read instead of bash' },
      ],
    });

    await collectStream(result);

    const sentEvents = mockSend.mock.calls[0][1].events;
    expect(sentEvents).toContainEqual(
      expect.objectContaining({
        type: 'user.tool_confirmation',
        tool_use_id: 'mcp_tu_2',
        result: 'deny',
        message: 'Use read instead of bash',
      }),
    );
  });
});
```

- [ ] **Step 2: Run new tests — expect FAIL**

Run: `pnpm test __tests__/anthropic/anthropic.provider.test.ts`
Expected: FAIL — toolResults are not yet handled in the provider.

### Task 3: Implement toolResults handling in Anthropic provider

**Files:**

- Modify: `src/anthropic/anthropic.provider.ts`

- [ ] **Step 1: Add a function to convert toolResults to Anthropic events**

Add this function above the `AnthropicProvider` class definition:

```typescript
function toAnthropicToolResultEvents(toolResults: ToolResult[]): object[] {
  return toolResults.map((tr) => {
    if (tr.approved !== undefined) {
      const event: Record<string, unknown> = {
        type: 'user.tool_confirmation',
        tool_use_id: tr.toolUseId,
        result: tr.approved ? 'allow' : 'deny',
      };
      if (!tr.approved && tr.output) {
        event.message = tr.output;
      }
      return event;
    }

    return {
      type: 'user.custom_tool_result',
      tool_use_id: tr.toolUseId,
      content: [{ type: 'text', text: tr.output ?? '' }],
      is_error: tr.isError ?? false,
    };
  });
}
```

Import `ToolResult` from `../types.js` (add to the existing import):

```typescript
import {
  ANTHROPIC,
  type ActionRequired,
  type McpServerConfig,
  type RequestParams,
  type Provider,
  type Response,
  type SessionOptions,
  type StreamPart,
  type StreamResult,
  type ToolResult,
  type Usage,
} from '../types.js';
```

- [ ] **Step 2: Update runStream to send toolResults before the user message**

In the `runStream` method, replace the events-send block (the `await this.client.beta.sessions.events.send(...)` call):

```typescript
      const eventsToSend: object[] = [];

      if (params.toolResults?.length) {
        eventsToSend.push(...toAnthropicToolResultEvents(params.toolResults));
      }

      eventsToSend.push({
        type: 'user.message',
        content: toContentBlocks(params.message.content),
      });

      await this.client.beta.sessions.events.send(sessionId, {
        events: eventsToSend as any,
      });
```

- [ ] **Step 3: Run tests — expect PASS**

Run: `pnpm test __tests__/anthropic/anthropic.provider.test.ts`
Expected: All tests pass.

- [ ] **Step 4: Run full test suite and build**

Run: `pnpm test && pnpm build`
Expected: All tests pass, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add tool results and MCP approval flow for Anthropic provider"
```

---

## Phase 4: OpenAI MCP Integration (deferred — depends on OpenAI provider)

**Prerequisite:** The OpenAI provider from [thalamus package plan](./2026-05-11-thalamus-package.md) Phase 3 must be implemented first. That plan creates `src/openai/openai.provider.ts` with the Responses API streaming flow.

**Goal:** When `mcpServers` is passed to `createOpenAIProvider()`, the provider injects `type: "mcp"` tool definitions into every `responses.create()` call. MCP approval requests map to `actionsRequired` with `type: 'mcp-approval'`. MCP approval responses flow through `toolResults`.

**What will change (outline — full steps written when OpenAI provider exists):**

1. `createOpenAIProvider` config gains `mcpServers?: McpServerConfig[]`
2. New helper `toOpenAIMcpTools(servers, sessionAuth?)` converts `McpServerConfig[]` to OpenAI `tools` array entries
3. `McpApprovalPolicy` maps to OpenAI `require_approval`:
   - `'always'` → `'always'`
   - `'never'` → `'never'`
   - `{ except: [...] }` → `{ never: { tool_names: [...] } }`
4. OpenAI stream handler maps `mcp_list_tools` events → `mcp-tools-discovered` StreamPart
5. OpenAI stream handler maps `mcp_call` events → `tool-use-start` + `tool-use-result` with `source: { type: 'mcp', serverName }`
6. OpenAI stream handler maps `mcp_approval_request` → `finishReason: 'requires-action'` + `actionsRequired` with `type: 'mcp-approval'`
7. When `toolResults` contains approval entries, provider sends `mcp_approval_response` items in the next request `input` array
8. `createSession` stores `mcpAuth` tokens and injects them as `authorization` on each MCP tool

---

## Type Evolution Summary

| Addition | Phase | Why |
|---|---|---|
| `McpServerConfig`, `McpApprovalPolicy`, `McpToolDef`, `ToolSource` | 1 | Foundation types for MCP across all providers |
| `source` on `tool-use-start`/`tool-use-result`, `mcp-tools-discovered` StreamPart | 1 | Consumers can distinguish MCP vs builtin vs custom tool activity |
| `SessionOptions`, `McpAuthConfig`, `createSession()` on Provider | 2 | Per-session MCP auth for multi-tenant vault isolation |
| `ToolResult`, `toolResults` on RequestParams, `mcp-approval` on ActionRequired | 3 | Client-side tool execution and MCP approval round-trip |
| OpenAI `mcpServers` → `tools` injection, approval mapping | 4 | Full OpenAI MCP support (deferred) |
