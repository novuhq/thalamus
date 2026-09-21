import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderAuthError, ProviderRateLimitError } from "../../src/errors.js";
import {
  assistantResourceName,
  createGoogleProvider,
  discoveryEngineEndpoint,
  mapGoogleError,
} from "../../src/google/google.provider.js";
import {
  mapChunk,
  ResponseAccumulator,
} from "../../src/google/google-parser.js";
import { MessageRole } from "../../src/types.js";
import {
  config,
  GE_SESSION,
  replyText,
  streamOf,
  succeeded,
} from "./_helpers.js";

afterEach(() => vi.clearAllMocks());

describe("mapChunk — text fragments", () => {
  it("appends groundedContent.text and skips thought fragments", () => {
    const acc = new ResponseAccumulator();
    const thought = [...mapChunk(replyText("hidden", true), acc)];
    expect(thought).toEqual([]);
    expect(acc.text).toBe("");

    const parts = [...mapChunk(replyText("Hell"), acc)];
    expect(parts).toContainEqual({ type: "text-delta", text: "Hell" });
    const more = [...mapChunk(replyText("o"), acc)];
    expect(more).toContainEqual({ type: "text-delta", text: "o" });
    expect(acc.text).toBe("Hello");
  });

  it("emits message and marks done on SUCCEEDED", () => {
    const acc = new ResponseAccumulator();
    [...mapChunk(replyText("Hello"), acc)];
    const parts = [...mapChunk(succeeded(), acc)];
    expect(parts).toContainEqual({ type: "message", text: "Hello" });
    expect(acc.done).toBe(true);
    expect(acc.finishReason).toBe("stop");
    expect(acc.messages).toEqual(["Hello"]);
  });

  it("marks finishReason error on FAILED", () => {
    const acc = new ResponseAccumulator();
    [...mapChunk({ answer: { state: "FAILED" } }, acc)];
    expect(acc.done).toBe(true);
    expect(acc.finishReason).toBe("error");
  });

  it("treats SKIPPED as a clean stop (greeting ignore)", () => {
    const acc = new ResponseAccumulator();
    [...mapChunk({ answer: { state: "SKIPPED" } }, acc)];
    expect(acc.done).toBe(true);
    expect(acc.finishReason).toBe("stop");
    expect(acc.messages).toEqual([]);
  });
});

describe("mapChunk — tools", () => {
  it("emits tool-use for invocationTools and invokedSkills", () => {
    const acc = new ResponseAccumulator();
    const parts = [
      ...mapChunk(
        {
          invocationTools: ["search_docs"],
          invokedSkills: [{ displayName: "Research" }],
        },
        acc,
      ),
    ];
    const starts = parts.filter((p) => p.type === "tool-use-start");
    expect(starts.map((p) => (p as { toolName: string }).toolName)).toEqual([
      "search_docs",
      "Research",
    ]);
  });

  it("emits web_grounding once from textGroundingMetadata references", () => {
    const acc = new ResponseAccumulator();
    const chunk = {
      answer: {
        state: "SUCCEEDED" as const,
        replies: [
          {
            groundedContent: {
              content: { text: "Today is Monday.", thought: false },
              textGroundingMetadata: {
                references: [
                  { documentMetadata: { title: "time.gov" } },
                  { documentMetadata: { title: "utctime.net" } },
                ],
              },
            },
          },
        ],
      },
    };
    const parts = [...mapChunk(chunk, acc)];
    const done = parts.find((p) => p.type === "tool-use-done");
    expect(done).toMatchObject({
      type: "tool-use-done",
      toolName: "web_grounding",
      input: { sources: ["time.gov", "utctime.net"] },
    });
    expect(parts.filter((p) => p.type === "tool-use-start")).toHaveLength(1);
  });
});

describe("mapChunk — session capture", () => {
  it("captures sessionInfo.session", () => {
    const acc = new ResponseAccumulator();
    [...mapChunk({ sessionInfo: { session: GE_SESSION } }, acc)];
    expect(acc.sessionId).toBe(GE_SESSION);
  });
});

describe("GoogleProvider — new session", () => {
  it("omits session on the first turn and returns the GE session name", async () => {
    const streamAssist = vi
      .fn()
      .mockReturnValue(streamOf(replyText("Hello"), succeeded(GE_SESSION)));
    const provider = createGoogleProvider({ ...config, streamAssist });
    const response = await provider.send({
      messages: [{ role: MessageRole.USER, content: "What is 2+2?" }],
    });

    expect(streamAssist).toHaveBeenCalledOnce();
    const request = streamAssist.mock.calls[0][0];
    expect(request.session).toBeUndefined();
    expect(request.query.text).toBe("What is 2+2?");
    expect(request.name).toBe(assistantResourceName(config));
    expect(response.sessionId).toBe(GE_SESSION);
    expect(response.messages).toEqual(["Hello"]);
    expect(response.finishReason).toBe("stop");
  });

  it("resolves SendResult.sessionId from sessionInfo on the first turn", async () => {
    const streamAssist = vi
      .fn()
      .mockReturnValue(streamOf(replyText("Hello"), succeeded(GE_SESSION)));
    const provider = createGoogleProvider({ ...config, streamAssist });
    const result = provider.send({
      messages: [{ role: MessageRole.USER, content: "What is 2+2?" }],
    });
    await expect(result.sessionId).resolves.toBe(GE_SESSION);
  });
});

describe("GoogleProvider — continuing session", () => {
  it("passes the GE session resource name", async () => {
    const streamAssist = vi
      .fn()
      .mockReturnValue(streamOf(succeeded(GE_SESSION, replyText("Sure!"))));
    const provider = createGoogleProvider({ ...config, streamAssist });
    const response = await provider.send({
      messages: [{ role: MessageRole.USER, content: "continue" }],
      sessionId: GE_SESSION,
    });

    const request = streamAssist.mock.calls[0][0];
    expect(request.session).toBe(GE_SESSION);
    expect(response.sessionId).toBe(GE_SESSION);
    expect(response.messages).toEqual(["Sure!"]);
  });

  it("does not let providerOptions overwrite name, query, or session", async () => {
    const streamAssist = vi
      .fn()
      .mockReturnValue(streamOf(succeeded(GE_SESSION)));
    const provider = createGoogleProvider({ ...config, streamAssist });
    await provider.send({
      messages: [{ role: MessageRole.USER, content: "keep me" }],
      sessionId: GE_SESSION,
      providerOptions: {
        name: "evil",
        query: { text: "overwritten" },
        session: "evil-session",
        toolsSpec: { webGroundingSpec: {} },
      },
    });
    const request = streamAssist.mock.calls[0][0];
    expect(request.name).toBe(assistantResourceName(config));
    expect(request.query.text).toBe("keep me");
    expect(request.session).toBe(GE_SESSION);
    expect(request.toolsSpec).toEqual({ webGroundingSpec: {} });
  });
});

describe("GoogleProvider — createSession", () => {
  it("does not return a send()-usable id", async () => {
    const provider = createGoogleProvider({
      ...config,
      streamAssist: () => streamOf(),
    });
    await expect(provider.createSession()).rejects.toMatchObject({
      name: "ThalamusError",
    });
  });
});

describe("GoogleProvider — streaming parts", () => {
  it("emits text-delta parts during stream", async () => {
    const parts: { type: string; text?: string }[] = [];
    const provider = createGoogleProvider({
      ...config,
      streamAssist: () =>
        streamOf(replyText("Part"), replyText(" two"), succeeded()),
      onSessionEvents: () => ({ onPart: (p) => parts.push(p) }),
    });

    await provider.send({
      messages: [{ role: MessageRole.USER, content: "stream me" }],
    });

    expect(
      parts.some((p) => p.type === "text-delta" && p.text === "Part"),
    ).toBe(true);
    expect(
      parts.some((p) => p.type === "text-delta" && p.text === " two"),
    ).toBe(true);
    expect(
      parts.some((p) => p.type === "message" && p.text === "Part two"),
    ).toBe(true);
  });
});

describe("GoogleProvider — errors", () => {
  it("maps gRPC 16 to ProviderAuthError", async () => {
    const err = Object.assign(new Error("UNAUTHENTICATED"), { code: 16 });
    const provider = createGoogleProvider({
      ...config,
      streamAssist: () => {
        throw err;
      },
    });
    await expect(
      provider.send({ messages: [{ role: MessageRole.USER, content: "x" }] }),
    ).rejects.toMatchObject({ name: "ProviderAuthError" });
  });

  it("maps gRPC 8 to ProviderRateLimitError", async () => {
    const err = Object.assign(new Error("RESOURCE_EXHAUSTED"), { code: 8 });
    const provider = createGoogleProvider({
      ...config,
      streamAssist: () => {
        throw err;
      },
    });
    await expect(
      provider.send({ messages: [{ role: MessageRole.USER, content: "x" }] }),
    ).rejects.toMatchObject({ name: "ProviderRateLimitError" });
  });
});

describe("helpers", () => {
  it("builds the assistant resource name and global endpoint", () => {
    expect(assistantResourceName(config)).toBe(
      "projects/test-project/locations/global/collections/default_collection/engines/test-engine-123/assistants/default_assistant",
    );
    expect(discoveryEngineEndpoint("global")).toBe(
      "global-discoveryengine.googleapis.com",
    );
    expect(discoveryEngineEndpoint("us-central1")).toBe(
      "us-central1-discoveryengine.googleapis.com",
    );
  });

  it("mapGoogleError keeps Thalamus errors", () => {
    const auth = new ProviderAuthError("nope", { provider: "google" });
    expect(mapGoogleError(auth)).toBe(auth);
    expect(
      mapGoogleError(
        new ProviderRateLimitError("slow", { provider: "google" }),
      ),
    ).toBeInstanceOf(ProviderRateLimitError);
  });
});
