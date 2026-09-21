import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AbortedError,
  ProviderAuthError,
  ProviderRateLimitError,
  ThalamusError,
} from "../../src/errors.js";
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
  it("emits thinking for thought fragments and text-delta for answer text", () => {
    const acc = new ResponseAccumulator();
    const thought = [
      ...mapChunk(replyText("I will search the web.", true), acc),
    ];
    expect(thought).toEqual([
      { type: "thinking", text: "I will search the web." },
    ]);
    expect(acc.text).toBe("");

    const parts = [...mapChunk(replyText("Hell"), acc)];
    expect(parts).toContainEqual({ type: "text-delta", text: "Hell" });
    const more = [...mapChunk(replyText("o"), acc)];
    expect(more).toContainEqual({ type: "text-delta", text: "o" });
    expect(acc.text).toBe("Hello");
  });

  it("does not include thought text in the final message", () => {
    const acc = new ResponseAccumulator();
    [...mapChunk(replyText("planning", true), acc)];
    [...mapChunk(replyText("pong"), acc)];
    const parts = [...mapChunk(succeeded(), acc)];
    expect(parts).toContainEqual({ type: "message", text: "pong" });
    expect(acc.messages).toEqual(["pong"]);
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

  it("throws on FAILED so send() rejects", () => {
    const acc = new ResponseAccumulator();
    expect(() => [...mapChunk({ answer: { state: "FAILED" } }, acc)]).toThrow(
      ThalamusError,
    );
    expect(acc.done).toBe(true);
    expect(acc.finishReason).toBe("error");
  });

  it("treats SKIPPED as a clean stop with a visible skip message", () => {
    const acc = new ResponseAccumulator();
    const parts = [
      ...mapChunk(
        {
          answer: {
            state: "SKIPPED",
            assistSkippedReasons: ["NON_ASSIST_SEEKING_QUERY_IGNORED"],
          },
        },
        acc,
      ),
    ];
    expect(acc.done).toBe(true);
    expect(acc.finishReason).toBe("stop");
    expect(parts).toContainEqual({
      type: "message",
      text: "Gemini Enterprise ignored that as a greeting, not a question. Ask something specific.",
    });
    expect(acc.messages).toEqual([
      "Gemini Enterprise ignored that as a greeting, not a question. Ask something specific.",
    ]);
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

  it("joins text parts on the last user message and does not reuse older turns", async () => {
    const streamAssist = vi
      .fn()
      .mockReturnValue(streamOf(succeeded(GE_SESSION)));
    const provider = createGoogleProvider({ ...config, streamAssist });
    await provider.send({
      messages: [
        { role: MessageRole.USER, content: "stale" },
        {
          role: MessageRole.USER,
          content: [
            { type: "text", text: "keep " },
            { type: "text", text: "me" },
          ],
        },
      ],
    });
    expect(streamAssist.mock.calls[0][0].query.text).toBe("keep me");
  });

  it("rejects image, image-url, and file parts instead of dropping them", async () => {
    const streamAssist = vi
      .fn()
      .mockReturnValue(streamOf(succeeded(GE_SESSION)));
    const provider = createGoogleProvider({ ...config, streamAssist });
    await expect(
      provider.send({
        messages: [
          { role: MessageRole.USER, content: "stale" },
          {
            role: MessageRole.USER,
            content: [
              { type: "text", text: "look" },
              { type: "image", data: "abc", mediaType: "image/png" },
            ],
          },
        ],
      }),
    ).rejects.toMatchObject({
      name: "ThalamusError",
      message: expect.stringContaining("image"),
    });
    expect(streamAssist).not.toHaveBeenCalled();
  });
});

describe("GoogleProvider — first-turn lock", () => {
  it("does not share a lock across two unsessioned sends", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const resume: Array<() => void> = [];
    const streamAssist = vi.fn().mockImplementation(async function* () {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => {
        resume.push(resolve);
      });
      inFlight -= 1;
      yield succeeded(`${GE_SESSION}-${resume.length}`);
    });
    const provider = createGoogleProvider({ ...config, streamAssist });
    const sends = Promise.all([
      provider.send({
        messages: [{ role: MessageRole.USER, content: "one" }],
      }),
      provider.send({
        messages: [{ role: MessageRole.USER, content: "two" }],
      }),
    ]);
    await vi.waitFor(() => expect(streamAssist).toHaveBeenCalledTimes(2));
    expect(maxInFlight).toBe(2);
    for (const release of resume) release();
    await sends;
  });
});

describe("GoogleProvider — abort", () => {
  it("cancels an in-flight stream when abort fires", async () => {
    const abort = new AbortController();
    let rejectWait: (error: Error) => void = () => {};
    const cancel = vi.fn(() => {
      rejectWait(Object.assign(new Error("Cancelled"), { name: "AbortError" }));
    });
    const streamAssist = vi.fn().mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        await new Promise<never>((_, reject) => {
          rejectWait = reject;
        });
      },
      cancel,
    }));
    const provider = createGoogleProvider({ ...config, streamAssist });
    const result = provider.send({
      messages: [{ role: MessageRole.USER, content: "hang" }],
      abortSignal: abort.signal,
    });
    const aborted = expect(result).rejects.toBeInstanceOf(AbortedError);
    await vi.waitFor(() => expect(streamAssist).toHaveBeenCalledOnce());
    abort.abort();
    await aborted;
    expect(cancel).toHaveBeenCalledOnce();
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
  it("rejects send() when the answer state is FAILED", async () => {
    const provider = createGoogleProvider({
      ...config,
      streamAssist: () => streamOf({ answer: { state: "FAILED" } }),
    });
    await expect(
      provider.send({ messages: [{ role: MessageRole.USER, content: "x" }] }),
    ).rejects.toMatchObject({
      name: "ThalamusError",
      message: "Gemini Enterprise answer failed",
    });
  });

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
