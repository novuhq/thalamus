"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/vault/index.ts
var vault_exports = {};
__export(vault_exports, {
  LocalVault: () => LocalVault,
  createMemoryVaultStore: () => createMemoryVaultStore
});
module.exports = __toCommonJS(vault_exports);

// src/vault/local-vault.ts
var LocalVault = class {
  id;
  provider;
  store;
  constructor(id, provider, store) {
    this.id = id;
    this.provider = provider;
    this.store = store;
  }
  async add(name, credential) {
    await this.store.set(this.id, name, credential);
  }
  async update(name, credential) {
    await this.store.set(this.id, name, credential);
  }
  async remove(name) {
    await this.store.remove(this.id, name);
  }
  async list() {
    const all = await this.store.getAll(this.id);
    return all.map((c) => ({
      name: c.name,
      type: c.type,
      status: c.status,
      expiresAt: c.expiresAt,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt
    }));
  }
  async destroy() {
    await this.store.removeVault(this.id);
  }
};

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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  LocalVault,
  createMemoryVaultStore
});
//# sourceMappingURL=index.cjs.map