/**
 * E2E test: consumer process recovery.
 *
 * To test:
 *   1. npx tsx scripts/e2e-recovery.ts          — sends a message, streams events
 *   2. Kill it mid-stream (Ctrl+C)
 *   3. npx tsx scripts/e2e-recovery.ts --wait   — just listens, pending retries arrive
 *
 * Usage:
 *   npx tsx scripts/e2e-recovery.ts [--wait]
 */

import { createServer } from "node:http";
import { config } from "dotenv";

config({ path: new URL(".env", import.meta.url) });

import { cloudflare } from "../src/durable/index.js";
import { MessageRole, type StreamPart, thalamus } from "../src/index.js";
import { createWebhookHandler } from "../src/webhook/index.js";

const ANTHROPIC_API_KEY = env("ANTHROPIC_API_KEY");
const ANTHROPIC_AGENT_ID = env("ANTHROPIC_AGENT_ID");
const ANTHROPIC_ENVIRONMENT_ID = env("ANTHROPIC_ENVIRONMENT_ID");
const CF_OBSERVER_URL = env("CF_OBSERVER_URL");
const CF_OBSERVER_API_KEY = process.env.CF_OBSERVER_API_KEY;
const WEBHOOK_URL = env("WEBHOOK_URL");
const WEBHOOK_SECRET = env("WEBHOOK_SECRET");

const waitMode = process.argv.includes("--wait");

function env(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing ${name} in scripts/.env`);
    process.exit(1);
  }
  return val;
}

// ─── Webhook receiver ────────────────────────────────────────────

const events: StreamPart[] = [];
let finishResolve: () => void;
const finishPromise = new Promise<void>((r) => {
  finishResolve = r;
});

const webhook = createWebhookHandler({
  secret: WEBHOOK_SECRET,
  onSessionEvents: (sessionId, metadata) => {
    console.log(`[webhook] session=${sessionId}`);
    return {
      onPart(part: StreamPart) {
        events.push(part);
        switch (part.type) {
          case "text-delta":
            process.stdout.write(part.text);
            break;
          case "status-change":
            console.log(`[status] ${part.status}`);
            break;
          case "finish":
            console.log(
              `\n[finish] reason=${part.response.finishReason} usage=${JSON.stringify(part.response.usage)}`,
            );
            finishResolve();
            break;
          case "error":
            console.error(`[error]`, part.error);
            finishResolve();
            break;
        }
      },
    };
  },
});

const PORT = 4567;
const server = createServer(async (req, res) => {
  if (req.url === "/webhook" && req.method === "POST") {
    await webhook.express(req, res);
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`Webhook server listening on http://localhost:${PORT}/webhook\n`);
});

// ─── Send or wait ────────────────────────────────────────────────

if (waitMode) {
  console.log("--wait mode: listening for pending retries (up to 90s)...\n");
} else {
  const provider = thalamus.anthropic({
    apiKey: ANTHROPIC_API_KEY,
    agentId: ANTHROPIC_AGENT_ID,
    environmentId: ANTHROPIC_ENVIRONMENT_ID,
    durable: cloudflare({
      url: CF_OBSERVER_URL,
      apiKey: CF_OBSERVER_API_KEY,
      webhook: { url: WEBHOOK_URL, secret: WEBHOOK_SECRET },
    }),
  });

  console.log(
    "--- Sending message (kill mid-stream to test recovery with --wait) ---\n",
  );

  const sessionId = await provider.send({
    messages: [
      {
        role: MessageRole.USER,
        content:
          "Write a detailed paragraph about the history of space exploration. Take your time.",
      },
    ],
  });

  console.log(`Session: ${sessionId}\n`);
}

if (waitMode) {
  // Keep running until manually killed — just like a production server
  process.on("SIGINT", () => {
    console.log(`\n--- Stopped ---`);
    console.log(`Events received: ${events.length}`);
    if (events.length > 0) {
      console.log(
        `Event types: ${[...new Set(events.map((e) => e.type))].join(", ")}`,
      );
    }
    server.close();
    process.exit(0);
  });
} else {
  // In send mode, wait for finish then exit
  const timeout = setTimeout(() => {
    console.error("\n✗ Timeout — no finish event after 90s");
    server.close();
    process.exit(1);
  }, 90_000);

  await finishPromise;
  clearTimeout(timeout);

  console.log("\n--- Summary ---");
  console.log(`Events received:  ${events.length}`);
  console.log(
    `Event types:      ${[...new Set(events.map((e) => e.type))].join(", ")}`,
  );
  console.log("\n✓ Done");
  server.close();
}
