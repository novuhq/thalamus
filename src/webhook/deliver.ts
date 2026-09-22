import type { StreamPart } from "../types";

export type DeliverWebhookEventInput = {
  url: string;
  secret: string;
  sessionId: string;
  runId: string;
  turnId: string;
  sequence: number;
  provider: string;
  metadata?: Record<string, string>;
  event: StreamPart;
};

function serializeEvent(event: StreamPart): unknown {
  if (event.type === "error") {
    return {
      type: "error",
      error: { message: event.error.message, name: event.error.name },
    };
  }

  return event;
}

export async function signWebhookBody(
  body: string,
  secret: string,
  timestamp: number,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const payload = `${timestamp}.${body}`;
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return `t=${timestamp},v1=${hex}`;
}

/**
 * POST one StreamPart to a Novu/Thalamus webhook endpoint.
 * Used by providers that cannot expose an HTTP SSE URL (gRPC streamAssist).
 */
export async function deliverWebhookEvent(
  input: DeliverWebhookEventInput,
): Promise<void> {
  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    sessionId: input.sessionId,
    runId: input.runId,
    turnId: input.turnId,
    sequence: input.sequence,
    timestamp,
    provider: input.provider,
    metadata: input.metadata ?? {},
    event: serializeEvent(input.event),
  });
  const signature = await signWebhookBody(body, input.secret, timestamp);
  const res = await fetch(input.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Thalamus-Signature": signature,
      "X-Thalamus-Event-Type": input.event.type,
      "X-Thalamus-Session-Id": input.sessionId,
      "X-Thalamus-Run-Id": input.runId,
      "X-Thalamus-Sequence": String(input.sequence),
    },
    body,
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`webhook delivery failed: HTTP ${res.status}`);
  }
}
