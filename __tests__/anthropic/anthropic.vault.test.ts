import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicProvider } from "../../src/anthropic/anthropic.provider.js";
import { MessageRole } from "../../src/types.js";
import { config } from "./_helpers.js";

const mockCreate = vi.fn();
const mockSseStream = vi.fn();
const mockSend = vi.fn();
const mockVaultCreate = vi.fn();
const mockVaultRetrieve = vi.fn();

vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  // biome-ignore lint/complexity/useArrowFunction: must be callable with `new`
  const MockAnthropic = function () {
    return {
      beta: {
        sessions: {
          create: mockCreate,
          events: { stream: mockSseStream, send: mockSend },
        },
        vaults: {
          create: mockVaultCreate,
          retrieve: mockVaultRetrieve,
        },
      },
    };
  };
  return {
    default: MockAnthropic,
    APIError: actual.APIError,
    APIUserAbortError: actual.APIUserAbortError,
  };
});

vi.mock("@anthropic-ai/aws-sdk", () => ({
  AnthropicAws: vi.fn(),
}));

afterEach(() => vi.clearAllMocks());

describe("vault support", () => {
  it("createVault proxies to Anthropic vaults.create", async () => {
    mockVaultCreate.mockResolvedValue({
      id: "vlt_abc",
      display_name: "Alice",
    });

    const provider = createAnthropicProvider(config);
    const vault = await provider.createVault({
      name: "Alice",
      metadata: { subscriberId: "sub_123" },
    });

    expect(vault.id).toBe("vlt_abc");
    expect(vault.provider).toBe("anthropic");
    expect(mockVaultCreate).toHaveBeenCalledWith({
      display_name: "Alice",
      metadata: { subscriberId: "sub_123" },
    });
  });

  it("getVault proxies to Anthropic vaults.retrieve", async () => {
    mockVaultRetrieve.mockResolvedValue({
      id: "vlt_abc",
      display_name: "Alice",
    });

    const provider = createAnthropicProvider(config);
    const vault = await provider.getVault("vlt_abc");

    expect(vault.id).toBe("vlt_abc");
    expect(mockVaultRetrieve).toHaveBeenCalledWith("vlt_abc");
  });
});

describe("session lifecycle", () => {
  it("createSession creates a session with vault_ids", async () => {
    mockCreate.mockResolvedValue({ id: "sess_vault" });

    const provider = createAnthropicProvider(config);
    const sessionId = await provider.createSession({
      vaultIds: ["vlt_abc", "vlt_shared"],
    });

    expect(sessionId).toBe("sess_vault");
    expect(mockCreate).toHaveBeenCalledWith({
      agent: "agent_abc",
      environment_id: "env_xyz",
      vault_ids: ["vlt_abc", "vlt_shared"],
    });
  });

  it("createSession without vaultIds creates session without vault_ids", async () => {
    mockCreate.mockResolvedValue({ id: "sess_no_vault" });

    const provider = createAnthropicProvider(config);
    const sessionId = await provider.createSession();

    expect(sessionId).toBe("sess_no_vault");
    expect(mockCreate).toHaveBeenCalledWith({
      agent: "agent_abc",
      environment_id: "env_xyz",
    });
  });
});
