// src/vault/memory-vault-store.ts
var counter = 0;
function createMemoryVaultStore() {
  const vaults = /* @__PURE__ */ new Map();
  const credentials = /* @__PURE__ */ new Map();
  return {
    async createVault(options) {
      const record = {
        id: `vlt_mem_${++counter}`,
        name: options.name,
        metadata: options.metadata,
        createdAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      vaults.set(record.id, record);
      return { ...record };
    },
    async getVault(vaultId) {
      const vault = vaults.get(vaultId);
      return vault ? { ...vault } : null;
    },
    async updateVaultMetadata(vaultId, metadata) {
      const vault = vaults.get(vaultId);
      if (vault) {
        vault.metadata = { ...vault.metadata, ...metadata };
      }
    },
    async removeVault(vaultId) {
      vaults.delete(vaultId);
      credentials.delete(vaultId);
    },
    async set(vaultId, name, credential) {
      let vaultCreds = credentials.get(vaultId);
      if (!vaultCreds) {
        vaultCreds = /* @__PURE__ */ new Map();
        credentials.set(vaultId, vaultCreds);
      }
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const stored = {
        name,
        type: credential.type,
        credential,
        status: "active",
        expiresAt: credential.type === "oauth" ? credential.expiresAt : void 0,
        createdAt: now,
        updatedAt: now
      };
      vaultCreds.set(name, stored);
    },
    async get(vaultId, name) {
      const stored = credentials.get(vaultId)?.get(name);
      return stored ? { ...stored } : null;
    },
    async getAll(vaultId) {
      const vaultCreds = credentials.get(vaultId);
      if (!vaultCreds) return [];
      return [...vaultCreds.values()].map((c) => ({ ...c }));
    },
    async remove(vaultId, name) {
      credentials.get(vaultId)?.delete(name);
    }
  };
}

export {
  createMemoryVaultStore
};
//# sourceMappingURL=chunk-2CE52QMW.js.map