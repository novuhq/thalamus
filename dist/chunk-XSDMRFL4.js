// src/durable/cloudflare.ts
function cloudflare(options) {
  const base = options.url.replace(/\/+$/, "");
  const headers = {
    "Content-Type": "application/json",
    ...options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}
  };
  return {
    webhook: options.webhook,
    async observe(params) {
      const res = await fetch(`${base}/observe`, {
        method: "POST",
        headers,
        body: JSON.stringify(params)
      });
      if (!res.ok) {
        throw new Error(`cloudflare observe failed: ${res.status}`);
      }
    },
    async stop(sessionId) {
      const res = await fetch(
        `${base}/observe/${encodeURIComponent(sessionId)}`,
        { method: "DELETE", headers }
      );
      if (!res.ok && res.status !== 404) {
        throw new Error(`cloudflare stop failed: ${res.status}`);
      }
    }
  };
}

export {
  cloudflare
};
//# sourceMappingURL=chunk-XSDMRFL4.js.map