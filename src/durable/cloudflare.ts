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
}

export function cloudflare(
  options: CloudflareBackendOptions,
): CloudflareEdgeObserver {
  const base = options.url.replace(/\/+$/, "");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
  };

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
  };
}
