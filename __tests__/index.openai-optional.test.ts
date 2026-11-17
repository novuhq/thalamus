import { describe, expect, it, vi } from "vitest";
import { ThalamusError } from "../src/errors.js";
import { thalamus } from "../src/index.js";
import { MessageRole } from "../src/types.js";

const openaiLoad = vi.hoisted(() => ({ count: 0 }));

vi.mock("openai", () => {
  openaiLoad.count += 1;
  throw new Error("openai is not installed");
});

describe("root entry without openai installed", () => {
  it("loads Anthropic, constructs OpenAI, and fails the first send", async () => {
    expect(openaiLoad.count).toBe(0);

    const anthropic = thalamus.anthropic({
      apiKey: "sk-test",
      agentId: "agent_abc",
      environmentId: "env_xyz",
    });
    const openai = thalamus.openai({ apiKey: "sk-test" });

    expect(typeof anthropic.send).toBe("function");
    expect(typeof openai.send).toBe("function");
    expect(openaiLoad.count).toBe(0);

    await expect(
      openai.send({
        messages: [{ role: MessageRole.USER, content: "hi" }],
      }),
    ).rejects.toMatchObject({
      name: "ThalamusError",
      isRetryable: false,
      message: expect.stringContaining("openai >= 6.45.0"),
    });
    expect(openaiLoad.count).toBeGreaterThan(0);

    await expect(
      openai.send({
        messages: [{ role: MessageRole.USER, content: "hi" }],
      }),
    ).rejects.toBeInstanceOf(ThalamusError);
  });
});
