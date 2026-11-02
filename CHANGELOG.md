# Changelog

## v0.1.0-alpha.20 (2026-10-07)

### 🚀 Features

- **anthropic:** native agent overrides, refusal stop reason (part of NV-8926, part of NV-8924) ([#22](https://github.com/novuhq/thalamus/pull/22))

### ⚠️ Breaking Changes

- The `@anthropic-ai/sdk` peer dependency is now `>=0.130.0` (the `refusal` stop reason and `stop_details` first ship there).

### ❤️ Thank You

- Adam Chmara

## v0.1.0-alpha.19 (2026-10-05)

### 🚀 Features

- **anthropic:** emit text-start/text-delta from managed agents event_deltas ([#20](https://github.com/novuhq/thalamus/pull/20))
- live() final text and streamed messages for webhook consumers ([#21](https://github.com/novuhq/thalamus/pull/21))

### ⚠️ Breaking Changes

- The `@anthropic-ai/sdk` peer dependency is now `>=0.109.0` (the preview event types and `event_deltas` param first ship there).
- Anthropic streams now emit `text-start` / `text-delta` parts. Edge workers on an older thalamus map unknown frames to `provider-event`, so upgrade the edge worker before the API that dispatches to it.
- `cloudflare().live()` returns a `LiveReply` (`AsyncIterable<string>` plus `final: Promise<string | undefined>`) instead of an async generator.
- The `isAnthropicPreviewEvent` export is removed.

### ❤️ Thank You

- Adam Chmara

## v0.1.0-alpha.18 (2026-08-12)

### 🩹 Fixes

- **anthropic:** observe before dispatching edge turns ([#18](https://github.com/novuhq/thalamus/pull/18))

### ❤️ Thank You

- Adam Chmara

## v0.1.0-alpha.17 (2026-08-11)

### 🩹 Fixes

- **anthropic,openai:** emit run-start from the parser, rename stream-start to run-start ([#17](https://github.com/novuhq/thalamus/pull/17))

### ⚠️ Breaking Changes

- The `stream-start` StreamPart is now `run-start`, and the `onStreamStart` callback is now `onRunStart`. Consumers that match on the serialized `type` string must upgrade in lockstep.

### ❤️ Thank You

- Adam Chmara

## v0.1.0-alpha.16 (2026-07-20)

### 🚀 Features

- emit non-fatal mcp-server-failure stream part for MCP init errors ([#16](https://github.com/novuhq/thalamus/pull/16))

### ❤️ Thank You

- Adam Chmara
