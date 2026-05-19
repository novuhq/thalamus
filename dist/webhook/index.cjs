"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/webhook/index.ts
var webhook_exports = {};
__export(webhook_exports, {
  createWebhookHandler: () => createWebhookHandler
});
module.exports = __toCommonJS(webhook_exports);
var CALLBACK_MAP = {
  "text-delta": "onTextDelta",
  thinking: "onThinking",
  refusal: "onRefusal",
  "tool-use-start": "onToolUseStart",
  "tool-use-delta": "onToolUseDelta",
  "tool-use-done": "onToolUseDone",
  "tool-use-result": "onToolUseResult",
  "mcp-tools-discovered": "onMcpToolsDiscovered",
  "status-change": "onStatusChange",
  "stream-start": "onStreamStart",
  finish: "onFinish",
  error: "onError",
  "provider-event": "onProviderEvent"
};
function createWebhookHandler(options) {
  const { secret, tolerance = 300, onSessionEvents } = options;
  const sessionCache = /* @__PURE__ */ new Map();
  function getCallbacks(sessionId, metadata) {
    let callbacks = sessionCache.get(sessionId);
    if (!callbacks) {
      callbacks = onSessionEvents(sessionId, metadata);
      sessionCache.set(sessionId, callbacks);
    }
    return callbacks;
  }
  function evictSession(sessionId) {
    sessionCache.delete(sessionId);
  }
  async function verifySignature(rawBody, signatureHeader) {
    const parts = signatureHeader.split(",");
    const tPart = parts.find((p) => p.startsWith("t="));
    const v1Part = parts.find((p) => p.startsWith("v1="));
    if (!tPart || !v1Part) return false;
    const timestamp = Number(tPart.slice(2));
    const signature = v1Part.slice(3);
    if (Number.isNaN(timestamp)) return false;
    const now = Math.floor(Date.now() / 1e3);
    if (Math.abs(now - timestamp) > tolerance) return false;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const payload = `${timestamp}.${rawBody}`;
    const expected = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(payload)
    );
    const expectedHex = Array.from(new Uint8Array(expected)).map((b) => b.toString(16).padStart(2, "0")).join("");
    return timingSafeEqual(signature, expectedHex);
  }
  function dispatch(callbacks, event) {
    callbacks.onPart?.(event);
    const key = CALLBACK_MAP[event.type];
    const cb = callbacks[key];
    if (cb) cb(event);
  }
  async function processRequest(rawBody, signatureHeader) {
    if (!signatureHeader) {
      return new Response(
        JSON.stringify({ error: "Missing X-Thalamus-Signature header" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }
    const valid = await verifySignature(rawBody, signatureHeader);
    if (!valid) {
      return new Response(
        JSON.stringify({ error: "Invalid signature" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }
    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return new Response(
        JSON.stringify({ error: "Malformed JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
    const { sessionId, metadata, event } = payload;
    if (!sessionId || !event?.type) {
      return new Response(
        JSON.stringify({ error: "Missing sessionId or event" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
    const callbacks = getCallbacks(sessionId, metadata ?? {});
    try {
      dispatch(callbacks, event);
    } catch (err) {
      return new Response(
        JSON.stringify({ error: "Callback error" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
    if (event.type === "finish" || event.type === "error") {
      evictSession(sessionId);
    }
    return new Response(null, { status: 200 });
  }
  return {
    async handle(req) {
      if (req.method !== "POST") {
        return new Response(
          JSON.stringify({ error: "Method not allowed" }),
          { status: 405, headers: { "Content-Type": "application/json" } }
        );
      }
      const rawBody = await req.text();
      const signatureHeader = req.headers.get("X-Thalamus-Signature");
      return processRequest(rawBody, signatureHeader);
    },
    async express(req, res) {
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }
      const rawBody = await readNodeBody(req);
      const signatureHeader = req.headers["x-thalamus-signature"] ?? null;
      const response = await processRequest(rawBody, signatureHeader);
      res.writeHead(response.status, {
        "Content-Type": response.headers.get("Content-Type") ?? "application/json"
      });
      res.end(await response.text());
    }
  };
}
function timingSafeEqual(a, b) {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  let result = 0;
  for (let i = 0; i < bufA.byteLength; i++) {
    result |= bufA[i] ^ bufB[i];
  }
  return result === 0;
}
function readNodeBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  createWebhookHandler
});
//# sourceMappingURL=index.cjs.map