import { describe, expect, it, vi } from "vitest";
import { ThalamusError } from "../../src/errors.js";
import { createOpenAIProvider } from "../../src/openai/openai.provider.js";
import { MessageRole } from "../../src/types.js";
import { sigv4Config } from "./_helpers.js";

const mockResponsesCreate = vi.fn();

vi.mock("openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openai")>();
  // biome-ignore lint/complexity/useArrowFunction: must be callable with `new`
  const MockOpenAI = function () {
    return {
      responses: { create: mockResponsesCreate },
      conversations: { create: vi.fn() },
    };
  };
  return { ...actual, default: MockOpenAI };
});

vi.mock("openai/providers/bedrock/aws", () => {
  throw new Error("missing");
});

describe("Bedrock SigV4 missing peers", () => {
  it("rejects send when the aws provider module is missing", async () => {
    let caught: unknown;
    try {
      await createOpenAIProvider(sigv4Config).send({
        messages: [{ role: MessageRole.USER, content: "Hi" }],
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ThalamusError);
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain("@aws-sdk/credential-provider-node");
    expect(message).toContain("@smithy/hash-node");
    expect(message).toContain("@smithy/signature-v4");
    expect(mockResponsesCreate).not.toHaveBeenCalled();
  });
});
