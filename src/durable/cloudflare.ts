import { type LiveOptions, readLiveEvents } from "./live";
import type {
  EdgeEnqueueParams,
  EdgeObserveParams,
  EdgeObserver,
} from "./types";

export interface WebhookConfig {
  url: string;
  secret: string;
}

export interface CloudflareBackendOptions {
  url: string;
  apiKey?: string;
  webhook: WebhookConfig;
}

export interface CloudflareEdgeObserver extends EdgeObserver {
  readonly webhook: WebhookConfig;
  live(
    sessionId: string,
    messageId: string,
    opts?: LiveOptions,
  ): AsyncIterable<string>;
}

export function cloudflare(
  options: CloudflareBackendOptions,
): CloudflareEdgeObserver {
  const base = options.url.replace(/\/+$/, "");
  const auth: Record<string, string> = options.apiKey
    ? { Authorization: `Bearer ${options.apiKey}` }
    : {};
  const headers = { "Content-Type": "application/json", ...auth };

  return {
    webhook: options.webhook,

    async enqueue(params: EdgeEnqueueParams) {
      const res = await fetch(`${base}/enqueue`, {
        method: "POST",
        headers,
        body: JSON.stringify(params),
      });
      if (!res.ok) {
        throw new Error(`cloudflare enqueue failed: ${res.status}`);
      }
      return (await res.json()) as { status: "active" | "queued" };
    },

    async observe(params: EdgeObserveParams) {
      const res = await fetch(`${base}/observe`, {
        method: "POST",
        headers,
        body: JSON.stringify(params),
      });
      if (!res.ok) {
        throw new Error(`cloudflare observe failed: ${res.status}`);
      }
    },

    async stop(sessionId: string) {
      const res = await fetch(
        `${base}/observe/${encodeURIComponent(sessionId)}`,
        { method: "DELETE", headers },
      );
      if (!res.ok && res.status !== 404) {
        throw new Error(`cloudflare stop failed: ${res.status}`);
      }
    },

    async *live(sessionId, messageId, opts = {}) {
      const res = await fetch(
        `${base}/live/${encodeURIComponent(sessionId)}?messageId=${encodeURIComponent(messageId)}`,
        {
          headers: { Accept: "text/event-stream", ...auth },
          signal: opts.signal,
        },
      );
      // Another reader owns this reply; the durable message still arrives by webhook.
      if (res.status === 409) {
        await res.body?.cancel();
        return;
      }
      if (!res.ok || !res.body) {
        throw new Error(`cloudflare live failed: ${res.status}`);
      }
      for await (const event of readLiveEvents(res.body, opts.signal)) {
        if (event.type === "end") return;
        yield event.text;
      }
      throw new Error("cloudflare live stream closed before end");
    },
  };
}
