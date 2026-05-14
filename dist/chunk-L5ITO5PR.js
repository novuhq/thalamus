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

export {
  LocalVault
};
//# sourceMappingURL=chunk-L5ITO5PR.js.map