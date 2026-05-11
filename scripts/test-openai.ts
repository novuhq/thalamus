/**
 * Manual test script for the OpenAI provider.
 *
 * Usage:
 *   npx tsx scripts/test-openai.ts
 *
 * Reads env vars from scripts/.env
 *
 * Required env vars:
 *   OPENAI_API_KEY     - Your OpenAI API key
 *
 * Optional env vars:
 *   OPENAI_MODEL       - Model to use (default: gpt-4o)
 */

import { config } from 'dotenv';
config({ path: new URL('.env', import.meta.url) });

import { thalamus, MessageRole } from '../src/index.js';

const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
  console.error('Missing required env var: OPENAI_API_KEY');
  console.error('Add it to scripts/.env');
  process.exit(1);
}

const model = process.env.OPENAI_MODEL ?? 'gpt-4o';

const provider = thalamus.openai({
  apiKey,
  model,
  instructions: 'You are a helpful assistant. Keep responses concise.',
});

console.log(`Provider: ${provider.provider}, runtimeId: ${provider.runtimeId}\n`);
console.log('--- Streaming turn 1 ---\n');

const result = await provider.stream({
  message: { role: MessageRole.USER, content: 'What is the capital of France? Reply in one sentence.' },
});

let sessionId: string | undefined;

for await (const part of result.stream) {
  switch (part.type) {
    case 'stream-start':
      sessionId = part.sessionId;
      console.log(`[stream-start] sessionId: ${sessionId}`);
      break;
    case 'text-delta':
      process.stdout.write(part.text);
      break;
    case 'thinking':
      console.log(`\n[thinking] ${part.text}`);
      break;
    case 'tool-use-start':
      console.log(`\n[tool-use] ${part.toolName} (${part.toolUseId})`);
      break;
    case 'tool-use-result':
      console.log(`[tool-result] ${part.toolUseId}: ${part.output?.slice(0, 100)}`);
      break;
    case 'status-change':
      console.log(`[status] ${part.status}`);
      break;
    case 'finish':
      console.log(`\n\n[finish] reason: ${part.response.finishReason}, tokens: ${JSON.stringify(part.response.usage)}`);
      break;
    case 'error':
      console.error(`\n[error]`, part.error);
      break;
    case 'provider-event':
      console.log(`[provider-event] ${part.event}`);
      break;
  }
}

// --- Turn 2: resume session ---
if (sessionId) {
  console.log('\n--- Streaming turn 2 (resumed) ---\n');

  const result2 = await provider.stream({
    message: { role: MessageRole.USER, content: 'And what is its population?' },
    sessionId,
  });

  for await (const part of result2.stream) {
    switch (part.type) {
      case 'stream-start':
        sessionId = part.sessionId;
        console.log(`[stream-start] sessionId: ${sessionId}`);
        break;
      case 'text-delta':
        process.stdout.write(part.text);
        break;
      case 'finish':
        console.log(`\n\n[finish] reason: ${part.response.finishReason}, tokens: ${JSON.stringify(part.response.usage)}`);
        break;
      case 'error':
        console.error(`\n[error]`, part.error);
        break;
    }
  }
}
