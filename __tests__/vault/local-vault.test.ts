import { describe, expect, it } from "vitest";
import { LocalVault } from "../../src/vault/local-vault";
import { createMemoryVaultStore } from "../../src/vault/memory-vault-store";

describe("LocalVault", () => {
  async function setup() {
    const store = createMemoryVaultStore();
    const record = await store.createVault({ name: "Test" });
    const vault = new LocalVault(record.id, "openai", store);
    return { store, vault, vaultId: record.id };
  }

  it("add stores a bearer credential", async () => {
    const { store, vault, vaultId } = await setup();

    await vault.add("github", { type: "bearer", token: "ghp_xxx" });

    const stored = await store.get(vaultId, "github");
    expect(stored).not.toBeNull();
    expect(stored!.type).toBe("bearer");
    expect(stored!.credential).toEqual({ type: "bearer", token: "ghp_xxx" });
  });

  it("add stores an oauth credential", async () => {
    const { store, vault, vaultId } = await setup();

    await vault.add("slack", {
      type: "oauth",
      accessToken: "xoxb-xxx",
      expiresAt: "2026-06-01T00:00:00Z",
      refresh: {
        refreshToken: "ref_xxx",
        tokenEndpoint: "https://slack.com/api/oauth.v2.access",
        clientId: "client_id",
      },
    });

    const stored = await store.get(vaultId, "slack");
    expect(stored!.type).toBe("oauth");
    expect(stored!.credential.type).toBe("oauth");
  });

  it("update replaces a credential", async () => {
    const { store, vault, vaultId } = await setup();

    await vault.add("github", { type: "bearer", token: "ghp_old" });
    await vault.update("github", { type: "bearer", token: "ghp_new" });

    const stored = await store.get(vaultId, "github");
    expect(stored!.credential).toEqual({ type: "bearer", token: "ghp_new" });
  });

  it("remove deletes a credential from the store", async () => {
    const { store, vault, vaultId } = await setup();

    await vault.add("github", { type: "bearer", token: "ghp_xxx" });
    await vault.remove("github");

    expect(await store.get(vaultId, "github")).toBeNull();
  });

  it("list returns credential info without secrets", async () => {
    const { vault } = await setup();

    await vault.add("github", { type: "bearer", token: "ghp_xxx" });
    await vault.add("slack", { type: "oauth", accessToken: "xoxb-xxx" });

    const list = await vault.list();
    expect(list).toHaveLength(2);
    expect(list.find((c) => c.name === "github")).toMatchObject({
      type: "bearer",
      status: "active",
    });
    expect(list.find((c) => c.name === "slack")).toMatchObject({
      type: "oauth",
      status: "active",
    });
    expect(list.every((c) => c.createdAt && c.updatedAt)).toBe(true);
  });

  it("destroy deletes the vault from the store", async () => {
    const { store, vault, vaultId } = await setup();

    await vault.destroy();

    expect(await store.getVault(vaultId)).toBeNull();
  });
});
