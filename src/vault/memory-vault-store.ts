import type {
  Credential,
  StoredCredential,
  VaultOptions,
  VaultRecord,
  VaultStore,
} from "./vault.interface";

let counter = 0;

export function createMemoryVaultStore(): VaultStore {
  const vaults = new Map<string, VaultRecord>();
  const credentials = new Map<string, Map<string, StoredCredential>>();

  return {
    async createVault(options: VaultOptions): Promise<VaultRecord> {
      const record: VaultRecord = {
        id: `vlt_mem_${++counter}`,
        name: options.name,
        metadata: options.metadata,
        createdAt: new Date().toISOString(),
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

    async set(vaultId, name, credential: Credential) {
      let vaultCreds = credentials.get(vaultId);
      if (!vaultCreds) {
        vaultCreds = new Map();
        credentials.set(vaultId, vaultCreds);
      }
      const now = new Date().toISOString();
      const stored: StoredCredential = {
        name,
        type: credential.type,
        credential,
        status: "active",
        expiresAt:
          credential.type === "oauth" ? credential.expiresAt : undefined,
        createdAt: now,
        updatedAt: now,
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
    },
  };
}
