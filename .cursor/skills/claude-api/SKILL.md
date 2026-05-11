---
name: claude-api
description: "Build and debug Anthropic Managed Agents in TypeScript. TRIGGER when: code imports `@anthropic-ai/sdk`; user asks about Managed Agents, agent sessions, agent environments, agent tools, agent events, agent memory, or the Anthropic SDK; user creates/modifies agents, sessions, environments, vaults, memory stores, or skills via the Anthropic API. SKIP: file imports `openai`/other-provider SDK, provider-neutral code, general programming/ML."
license: Complete terms in LICENSE.txt
---

# Managed Agents — TypeScript

This skill helps you build Managed Agents with the Anthropic TypeScript SDK (`@anthropic-ai/sdk`). Managed Agents are server-managed stateful agents where Anthropic runs the agent loop and hosts a per-session container for tool execution (bash, file ops, code execution).

## Before You Start

Scan the target file for non-Anthropic provider markers — `import openai`, `OpenAI(`, `gpt-4`, `gpt-5`. If found, stop and ask the user whether they want to switch to Claude.

## Defaults

Unless the user requests otherwise, use:
- **Model:** `claude-opus-4-7` (exact string — do not append date suffixes)
- **Thinking:** `thinking: {type: "adaptive"}` for anything remotely complicated
- **Effort:** `output_config: {effort: "xhigh"}` for agentic workloads on Opus 4.7

**CRITICAL: Use only exact model ID strings.** `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`. Do not append date suffixes. If the user requests an older model, read `shared/models.md`.

## SDK Usage

Never guess SDK usage. Function names, class names, method signatures, and import paths must come from `typescript/managed-agents/README.md` or the official SDK repo (URL in `shared/live-sources.md`). If a binding isn't documented, WebFetch it — don't infer.

**Don't reimplement SDK functionality.** Use typed exception classes (`Anthropic.RateLimitError`, etc.) and SDK types (`Anthropic.MessageParam`, `Anthropic.Tool`, `Anthropic.Message`, etc.) instead of redefining equivalent interfaces.

---

## Managed Agents Overview

**Mandatory flow:** Agent (once) → Session (every run).
- `model`/`system`/`tools` live on the **Agent**, never the session.
- **Agents are persistent — create once, reference by ID.** Store the agent ID returned by `agents.create` and pass it to every subsequent `sessions.create`; do not call `agents.create` in the request path.

**Beta headers:** `managed-agents-2026-04-01` — the SDK sets this automatically for all `client.beta.{agents,environments,sessions,vaults,memory_stores}.*` calls.

**First-party only.** Not available on Amazon Bedrock, Google Vertex AI, or Microsoft Foundry.

---

## Subcommands

| Subcommand | Action |
|---|---|
| `managed-agents-onboard` | Walk the user through setting up a Managed Agent from scratch. **Read `shared/managed-agents-onboarding.md` immediately** and follow its interview script. |

---

## Current Models (cached: 2026-04-15)

| Model | Model ID | Context | Input $/1M | Output $/1M |
| ----------------- | ------------------- | ------- | ---------- | ----------- |
| Claude Opus 4.7 | `claude-opus-4-7` | 1M | $5.00 | $25.00 |
| Claude Opus 4.6 | `claude-opus-4-6` | 1M | $5.00 | $25.00 |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | 1M | $3.00 | $15.00 |
| Claude Haiku 4.5 | `claude-haiku-4-5` | 200K | $1.00 | $5.00 |

---

## Thinking & Effort (Quick Reference)

**Opus 4.7 — Adaptive only.** `thinking: {type: "adaptive"}`. `budget_tokens` returns 400. Sampling params (`temperature`, `top_p`, `top_k`) also removed. See `shared/model-migration.md`.

**Effort parameter (GA):** `output_config: {effort: "low"|"medium"|"high"|"xhigh"|"max"}` (inside `output_config`). `xhigh` is the sweet spot for agentic workloads on Opus 4.7. `max` is Opus-only.

**Thinking content omitted by default on 4.7:** Set `thinking: {type: "adaptive", display: "summarized"}` to restore visible progress.

**Task Budgets (beta, Opus 4.7):** `output_config: {task_budget: {type: "tokens", total: N}}` — minimum 20,000; beta header `task-budgets-2026-03-13`. Distinct from `max_tokens`. See `shared/model-migration.md`.

---

## Reading Guide

**Getting started / setting up a new agent:**
→ Read `typescript/managed-agents/README.md` + `shared/managed-agents-overview.md` + `shared/managed-agents-onboarding.md`

**Core concepts (agent lifecycle, sessions, containers):**
→ Read `shared/managed-agents-core.md`

**Environments (sandboxes, file mounts, secrets):**
→ Read `shared/managed-agents-environments.md`

**Tools (built-in tools, custom tools, skills, MCP):**
→ Read `shared/managed-agents-tools.md`

**Events & streaming (SSE event types, stream handling):**
→ Read `shared/managed-agents-events.md`

**Session outcomes (success, failure, idle, terminated):**
→ Read `shared/managed-agents-outcomes.md`

**Client patterns (reconnect, interrupt, queued/processed gate, file mounts):**
→ Read `shared/managed-agents-client-patterns.md`

**Multi-agent orchestration:**
→ Read `shared/managed-agents-multiagent.md`

**Webhooks:**
→ Read `shared/managed-agents-webhooks.md`

**Memory stores:**
→ Read `shared/managed-agents-memory.md`

**Full API reference:**
→ Read `shared/managed-agents-api-reference.md`

**Model migration / upgrading:**
→ Read `shared/model-migration.md`

**Error codes:**
→ Read `shared/error-codes.md`

**Latest docs URLs (for WebFetch):**
→ Read `shared/live-sources.md`

**Model capabilities / context windows:**
→ Read `shared/models.md`

---

## Common Pitfalls

- **Agents are persistent.** Don't call `agents.create` in the request path — create once, store the ID, reference it in `sessions.create`.
- **`model`/`system`/`tools` go on the Agent, not the Session.**
- **Opus 4.7 thinking:** Adaptive only. `budget_tokens` returns 400.
- **4.6/4.7 prefill removed:** Assistant message prefills return 400 on Opus 4.6/4.7/Sonnet 4.6.
- **Confirm migration scope before editing:** When asked to migrate code without naming specific files, ask first.
- **`max_tokens` defaults:** Non-streaming: `~16000`. Streaming: `~64000`.
- **Don't truncate inputs.** If content is too long, notify the user.
