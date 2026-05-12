import type {
  Credential,
  CredentialInfo,
  Vault,
  VaultStore,
} from "./vault.interface";

export class VaultBacked implements Vault {
  readonly id: string;
  readonly provider: string;
  private readonly store: VaultStore;

  constructor(id: string, provider: string, store: VaultStore) {
    this.id = id;
    this.provider = provider;
    this.store = store;
  }

  async add(name: string, credential: Credential): Promise<void> {
    await this.store.set(this.id, name, credential);
  }

  async update(name: string, credential: Credential): Promise<void> {
    await this.store.set(this.id, name, credential);
  }

  async remove(name: string): Promise<void> {
    await this.store.remove(this.id, name);
  }

  async list(): Promise<CredentialInfo[]> {
    const all = await this.store.getAll(this.id);
    return all.map((c) => ({
      name: c.name,
      type: c.type,
      status: c.status,
      expiresAt: c.expiresAt,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }));
  }

  async destroy(): Promise<void> {
    await this.store.removeVault(this.id);
  }
}
