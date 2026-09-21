# HANDOFF — Thalamus Google Provider

## Status: review [1] applied — session identity fixed

`pnpm typecheck` ✅ · `pnpm test` ✅ (267)

```
PASS  message/reply     finish=stop message="pong"
PASS  web_grounding     sources=["utctime.net","worldtimeserver.com"]
SKIP  mcp/hitl-approval assistant.enabledTools is empty
```

Live check is `scripts/google-e2e.ts` (gitignored under `/scripts/`). Not in the tree.

---

## What changed

Provider uses `@google-cloud/discoveryengine` (`v1beta.AssistantServiceClient.streamAssist`) and proto types.

Text path:

```
answer.replies[].groundedContent.content.text
```

Skip fragments with `thought: true`. Terminal states: `SUCCEEDED`, `SKIPPED`, `FAILED`.

Session: GE creates the session when `session` is omitted. No local UUID. `createSession()` throws. Use `response.sessionId` / `result.sessionId` after the first `send()`. `run-start` carries the GE resource name when `sessionInfo.session` arrives, so `SendResult.sessionId` resolves.

`providerOptions` cannot overwrite `name`, `query`, or `session`.

| File | Change |
|---|---|
| `src/google/google-parser.ts` | Maps `IStreamAssistResponse` → StreamParts |
| `src/google/google.provider.ts` | GAPIC client + ADC + `quotaProjectId`; no fake session UUID |
| `src/google/index.ts` | Re-exports |
| `package.json` | Optional peer `@google-cloud/discoveryengine` >=3 |
| `tsup.config.ts` | `google/index` entry |
| `__tests__/google/*` | Proto-shaped fixtures, injected `streamAssist` |
| `README.md` | Google row, factory, `text-delta` |

---

## gcloud (this machine)

`"hello"` is not a quota failure. GE returns `SKIPPED` / `NON_ASSIST_SEEKING_QUERY_IGNORED` for greetings.

```
gcloud config set project gemini-enterprise-test-509310
gcloud auth application-default set-quota-project gemini-enterprise-test-509310
```

```
projectId:   gemini-enterprise-test-509310
location:    global
engineId:    gemini-enterprise-17899859_1789985955771
assistantId: default_assistant
host:        global-discoveryengine.googleapis.com
```

---

## How to construct

```typescript
import { thalamus } from "@novu/thalamus";

const provider = thalamus.google({
  projectId: "gemini-enterprise-test-509310",
  location: "global",
  engineId: "gemini-enterprise-17899859_1789985955771",
});

const r1 = await provider.send({
  messages: [{ role: "user", content: "What is 2+2?" }],
});
const r2 = await provider.send({
  messages: [{ role: "user", content: "and 3+3?" }],
  sessionId: r1.sessionId,
});
```

Auth is ADC. Tests inject `streamAssist`.

Peer: `npm install @google-cloud/discoveryengine`

Do not send `"hello"` — GE skips it.

Web search is a built-in GE tool (`toolsSpec.webGroundingSpec`). MCP/HITL approval cannot run until an action is attached in the console (`enabledTools` is `{}`).

---

## Gaps

1. **HITL / tool approval** — v1beta maps `invocationTools` (`string[]`) and `invokedSkills` to informational `tool-use-*`. No `requires-action`. Synthetic `web_grounding` from citations is still emitted (optional review item, not changed).
2. **`createSession()` throws.** Real id is `response.sessionId` / `result.sessionId` after the first `send()` (project *number* in the resource name).
3. **Only last user text** is sent as `query.text`. History lives in the GE session.
4. **No webhook / reconnect / vault-beyond-local.**
