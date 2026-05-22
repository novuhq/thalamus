import { describe, expect, it } from "vitest";
import { parseAnthropicToolResultContent } from "../../src/anthropic/tool-result";

describe("parseAnthropicToolResultContent", () => {
  it("maps text and search_result blocks", () => {
    const content = parseAnthropicToolResultContent([
      { type: "text", text: "ok" },
      {
        type: "search_result",
        title: "Example",
        source: "https://example.com",
        content: [{ type: "text", text: "snippet" }],
      },
    ]);

    expect(content).toEqual([
      { type: "text", text: "ok" },
      {
        type: "citation",
        url: "https://example.com",
        title: "Example",
        excerpts: ["snippet"],
      },
    ]);
  });

  it("maps unknown block types", () => {
    const content = parseAnthropicToolResultContent([
      { type: "future_block", foo: "bar" },
    ]);
    expect(content[0]).toMatchObject({
      type: "unknown",
      providerType: "future_block",
      data: { type: "future_block", foo: "bar" },
    });
  });
});
