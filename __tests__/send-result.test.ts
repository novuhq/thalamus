import { describe, expect, it, vi } from "vitest";
import { createSendResult } from "../src/send-result.js";
import type { StreamCallbacks, StreamPart } from "../src/types.js";

async function* partsFrom(events: StreamPart[]): AsyncIterable<StreamPart> {
  for (const event of events) {
    yield event;
  }
}

describe("SendResult — async callback dispatch", () => {
  it("awaits async callbacks sequentially", async () => {
    const order: string[] = [];

    const events: StreamPart[] = [
      { type: "text-delta", text: "a" },
      { type: "text-delta", text: "b" },
      {
        type: "finish",
        response: { content: "ab", finishReason: "stop" },
      },
    ];

    const callbacks: StreamCallbacks = {
      onTextDelta: async ({ text }) => {
        await new Promise((r) => setTimeout(r, 20));
        order.push(`delta-${text}`);
      },
    };

    const result = createSendResult(partsFrom(events), "run_1", callbacks, {
      autoStart: true,
    });

    await result.response;
    expect(order).toEqual(["delta-a", "delta-b"]);
  });

  it("awaits onPart before type-specific callback", async () => {
    const order: string[] = [];

    const events: StreamPart[] = [
      { type: "text-delta", text: "x" },
      {
        type: "finish",
        response: { content: "x", finishReason: "stop" },
      },
    ];

    const callbacks: StreamCallbacks = {
      onPart: async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push("onPart");
      },
      onTextDelta: async () => {
        order.push("onTextDelta");
      },
    };

    const result = createSendResult(partsFrom(events), "run_2", callbacks, {
      autoStart: true,
    });

    await result.response;
    expect(order).toEqual(["onPart", "onTextDelta", "onPart"]);
  });

  it("propagates async callback errors as rejections", async () => {
    const events: StreamPart[] = [
      { type: "text-delta", text: "a" },
      {
        type: "finish",
        response: { content: "a", finishReason: "stop" },
      },
    ];

    const callbacks: StreamCallbacks = {
      onTextDelta: async () => {
        throw new Error("async boom");
      },
    };

    const result = createSendResult(partsFrom(events), "run_3", callbacks, {
      autoStart: true,
    });

    await expect(result.response).rejects.toThrow("async boom");
  });

  it("sync callbacks still work identically", async () => {
    const parts: string[] = [];

    const events: StreamPart[] = [
      { type: "text-delta", text: "hello" },
      { type: "text-delta", text: " world" },
      {
        type: "finish",
        response: { content: "hello world", finishReason: "stop" },
      },
    ];

    const callbacks: StreamCallbacks = {
      onTextDelta: ({ text }) => {
        parts.push(text);
      },
    };

    const result = createSendResult(partsFrom(events), "run_4", callbacks, {
      autoStart: true,
    });

    const response = await result.response;
    expect(parts).toEqual(["hello", " world"]);
    expect(response.content).toBe("hello world");
  });
});
