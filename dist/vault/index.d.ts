import { V as Vault, c as VaultStore, C as Credential, a as CredentialInfo } from '../vault.interface-BMCawAU1.js';
export { O as OAuthRefreshConfig, S as StoredCredential, b as VaultOptions, d as VaultRecord } from '../vault.interface-BMCawAU1.js';
export { c as createMemoryVaultStore } from '../memory-vault-store-BvS51wSV.js';

declare class LocalVault implements Vault {
    readonly id: string;
    readonly provider: string;
    private readonly store;
    constructor(id: string, provider: string, store: VaultStore);
    add(name: string, credential: Credential): Promise<void>;
    update(name: string, credential: Credential): Promise<void>;
    remove(name: string): Promise<void>;
    list(): Promise<CredentialInfo[]>;
    destroy(): Promise<void>;
}

export { Credential, CredentialInfo, LocalVault, Vault, VaultStore };
