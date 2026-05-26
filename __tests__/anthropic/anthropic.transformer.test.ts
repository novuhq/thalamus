import { describe, expect, it, vi } from "vitest";
import {
  buildSendEvents,
  toContentBlocks,
} from "../../src/anthropic/anthropic.transformer.js";
import { MessageRole } from "../../src/types.js";

describe("toContentBlocks", () => {
  it("converts a string to a single text block", () => {
    expect(toContentBlocks("Hello!")).toEqual([
      { type: "text", text: "Hello!" },
    ]);
  });

  it("converts a text content part", () => {
    expect(toContentBlocks([{ type: "text", text: "Hello!" }])).toEqual([
      { type: "text", text: "Hello!" },
    ]);
  });

  it("converts a base64 image content part", () => {
    expect(
      toContentBlocks([
        { type: "image", data: "abc123", mediaType: "image/png" },
      ]),
    ).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "abc123" },
      },
    ]);
  });

  it("converts an image-url content part", () => {
    expect(
      toContentBlocks([
        { type: "image-url", url: "https://example.com/img.png" },
      ]),
    ).toEqual([
      {
        type: "image",
        source: { type: "url", url: "https://example.com/img.png" },
      },
    ]);
  });

  it("converts a file content part to a document block", () => {
    expect(
      toContentBlocks([
        {
          type: "file",
          data: "cGRmIGRhdGE=",
          mediaType: "application/pdf",
          name: "report.pdf",
        },
      ]),
    ).toEqual([
      {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: "cGRmIGRhdGE=",
        },
        title: "report.pdf",
      },
    ]);
  });

  it("sets document title to null when file has no name", () => {
    const result = toContentBlocks([
      { type: "file", data: "dGV4dA==", mediaType: "text/plain" },
    ]);
    expect(result[0]).toMatchObject({ type: "document", title: null });
  });

  it("converts mixed content parts in order", () => {
    const result = toContentBlocks([
      { type: "text", text: "Look at this:" },
      { type: "image", data: "abc", mediaType: "image/jpeg" },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ type: "text" });
    expect(result[1]).toMatchObject({ type: "image" });
  });
});

describe("buildSendEvents", () => {
  it("emits one user.message per USER message", () => {
    expect(
      buildSendEvents({
        messages: [
          { role: MessageRole.USER, content: "First" },
          { role: MessageRole.USER, content: "Second" },
        ],
      }),
    ).toEqual([
      { type: "user.message", content: [{ type: "text", text: "First" }] },
      { type: "user.message", content: [{ type: "text", text: "Second" }] },
    ]);
  });

  it("drops assistant and system messages instead of merging them", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(
      buildSendEvents({
        messages: [
          { role: MessageRole.ASSISTANT, content: "Welcome!" },
          { role: MessageRole.USER, content: "Hello" },
        ],
      }),
    ).toEqual([
      { type: "user.message", content: [{ type: "text", text: "Hello" }] },
    ]);

    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("returns no events when only non-user messages are provided", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(
      buildSendEvents({
        messages: [{ role: MessageRole.ASSISTANT, content: "Welcome!" }],
      }),
    ).toEqual([]);

    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
