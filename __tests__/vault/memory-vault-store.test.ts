import { describe, expect, it } from "vitest";
import { createMemoryVaultStore } from "../../src/vault/memory-vault-store";
import type { Credential } from "../../src/vault/vault.interface";

const bearerCred: Credential = { type: "bearer", token: "test-token" };
const oauthCred: Credential = {
  type: "oauth",
  accessToken: "access-123",
  expiresAt: "2099-12-31T23:59:59Z",
};

describe("createMemoryVaultStore", () => {
  describe("vault CRUD", () => {
    it("creates a vault and returns a record with generated id", async () => {
      const store = createMemoryVaultStore();
      const record = await store.createVault({ name: "Alice" });

      expect(record.id).toBeDefined();
      expect(record.name).toBe("Alice");
      expect(record.createdAt).toBeDefined();
    });

    it("retrieves a vault by id", async () => {
      const store = createMemoryVaultStore();
      const record = await store.createVault({ name: "Alice" });

      const found = await store.getVault(record.id);
      expect(found).toEqual(record);
    });

    it("returns null for nonexistent vault", async () => {
      const store = createMemoryVaultStore();
      expect(await store.getVault("nonexistent")).toBeNull();
    });

    it("updates vault metadata", async () => {
      const store = createMemoryVaultStore();
      const record = await store.createVault({
        name: "Alice",
        metadata: { org: "acme" },
      });
      await store.updateVaultMetadata(record.id, { subscriberId: "sub_123" });

      const vault = await store.getVault(record.id);
      expect(vault?.metadata).toEqual({ org: "acme", subscriberId: "sub_123" });
    });

    it("removes a vault and its credentials", async () => {
      const store = createMemoryVaultStore();
      const record = await store.createVault({ name: "Alice" });
      await store.set(record.id, "github", bearerCred);
      await store.removeVault(record.id);

      expect(await store.getVault(record.id)).toBeNull();
      expect(await store.get(record.id, "github")).toBeNull();
    });
  });

  describe("credential CRUD", () => {
    it("sets and gets a credential", async () => {
      const store = createMemoryVaultStore();
      const { id } = await store.createVault({ name: "Alice" });

      await store.set(id, "github", bearerCred);

      const result = await store.get(id, "github");
      expect(result).toBeDefined();
      expect(result!.name).toBe("github");
      expect(result!.type).toBe("bearer");
      expect(result!.credential).toEqual(bearerCred);
      expect(result!.status).toBe("active");
      expect(result!.createdAt).toBeDefined();
      expect(result!.updatedAt).toBeDefined();
    });

    it("overwrites an existing credential", async () => {
      const store = createMemoryVaultStore();
      const { id } = await store.createVault({ name: "Alice" });

      await store.set(id, "github", bearerCred);
      await store.set(id, "github", oauthCred);

      const result = await store.get(id, "github");
      expect(result!.type).toBe("oauth");
      expect(result!.credential).toEqual(oauthCred);
    });

    it("returns null for nonexistent credential", async () => {
      const store = createMemoryVaultStore();
      expect(await store.get("vlt_1", "github")).toBeNull();
    });

    it("gets all credentials for a vault", async () => {
      const store = createMemoryVaultStore();
      const { id } = await store.createVault({ name: "Alice" });

      await store.set(id, "github", bearerCred);
      await store.set(id, "linear", oauthCred);

      const all = await store.getAll(id);
      expect(all).toHaveLength(2);
      expect(all.map((c) => c.name).sort()).toEqual(["github", "linear"]);
    });

    it("removes a credential", async () => {
      const store = createMemoryVaultStore();
      const { id } = await store.createVault({ name: "Alice" });

      await store.set(id, "github", bearerCred);
      await store.remove(id, "github");

      expect(await store.get(id, "github")).toBeNull();
    });

    it("returns empty array for getAll on vault with no credentials", async () => {
      const store = createMemoryVaultStore();
      const all = await store.getAll("vlt_nonexistent");
      expect(all).toEqual([]);
    });
  });
});
