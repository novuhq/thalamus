# Changelog

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
