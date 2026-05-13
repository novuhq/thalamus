import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAIProvider } from "../../src/openai/openai.provider.js";
import { MessageRole } from "../../src/types.js";
import { createMemoryVaultStore } from "../../src/vault/memory-vault-store.js";
import { config, makeStream } from "./_helpers.js";

const mockResponsesCreate = vi.fn();
const mockConversationsCreate = vi.fn();

vi.mock("openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openai")>();
  // biome-ignore lint/complexity/useArrowFunction: must be callable with `new`
  const MockOpenAI = function () {
    return {
      responses: { create: mockResponsesCreate },
      conversations: { create: mockConversationsCreate },
    };
  };
  return { default: MockOpenAI, APIError: actual.APIError };
});

afterEach(() => vi.clearAllMocks());

describe("vault support", () => {
  it("createVault creates a vault in the VaultStore", async () => {
    const store = createMemoryVaultStore();
    const provider = createOpenAIProvider({ ...config, vaultStore: store });

    const vault = await provider.createVault({ name: "Alice" });
    expect(vault.id).toBeDefined();
    expect(vault.provider).toBe("openai");

    const record = await store.getVault(vault.id);
    expect(record).not.toBeNull();
    expect(record?.name).toBe("Alice");
  });

  it("getVault retrieves an existing vault", async () => {
    const store = createMemoryVaultStore();
    const provider = createOpenAIProvider({ ...config, vaultStore: store });

    const created = await provider.createVault({ name: "Bob" });
    const retrieved = await provider.getVault(created.id);
    expect(retrieved.id).toBe(created.id);
  });

  it("getVault throws for nonexistent vault", async () => {
    const store = createMemoryVaultStore();
    const provider = createOpenAIProvider({ ...config, vaultStore: store });

    await expect(provider.getVault("vlt_nope")).rejects.toThrow(
      "Vault not found",
    );
  });

  it("createVault throws if no vaultStore configured", async () => {
    const provider = createOpenAIProvider(config);

    await expect(provider.createVault({ name: "Alice" })).rejects.toThrow(
      "Pass a vaultStore",
    );
  });
});

describe("session lifecycle with vault", () => {
  it("vaultIds on stream() injects credentials per-request", async () => {
    const store = createMemoryVaultStore();
    const provider = createOpenAIProvider({
      ...config,
      vaultStore: store,
      mcpServers: [{ name: "github", url: "https://mcp.github.com" }],
    });

    const vault = await provider.createVault({ name: "Bob" });
    await vault.add("github", { type: "bearer", token: "ghp_yyy" });

    mockConversationsCreate.mockResolvedValue({ id: "conv_sl" });
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: {
            id: "resp_sl",
            conversation: { id: "conv_sl" },
            status: "in_progress",
          },
        },
        {
          type: "response.completed",
          response: {
            id: "resp_sl",
            output_text: "ok",
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ]),
    );

    await provider.stream({
      messages: [{ role: MessageRole.USER, content: "hi" }],
      vaultIds: [vault.id],
    });

    const callArgs = mockResponsesCreate.mock.calls[0][0];
    const mcpTool = callArgs.tools?.find(
      (t: any) => t.type === "mcp" && t.server_label === "github",
    );
    expect(mcpTool.authorization).toBe("ghp_yyy");
  });

  it("vault credential takes priority over static server.authorization", async () => {
    const store = createMemoryVaultStore();
    const provider = createOpenAIProvider({
      ...config,
      vaultStore: store,
      mcpServers: [
        {
          name: "github",
          url: "https://mcp.github.com",
          authorization: "Bearer static_token",
        },
      ],
    });

    const vault = await provider.createVault({ name: "Carol" });
    await vault.add("github", { type: "bearer", token: "ghp_dynamic" });

    mockConversationsCreate.mockResolvedValue({ id: "conv_pri" });
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: {
            id: "resp_pri",
            conversation: { id: "conv_pri" },
            status: "in_progress",
          },
        },
        {
          type: "response.completed",
          response: {
            id: "resp_pri",
            output_text: "ok",
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ]),
    );

    await provider.stream({
      messages: [{ role: MessageRole.USER, content: "hi" }],
      vaultIds: [vault.id],
    });

    const callArgs = mockResponsesCreate.mock.calls[0][0];
    const mcpTool = callArgs.tools?.find(
      (t: any) => t.type === "mcp" && t.server_label === "github",
    );
    expect(mcpTool.authorization).toBe("ghp_dynamic");
  });
});
