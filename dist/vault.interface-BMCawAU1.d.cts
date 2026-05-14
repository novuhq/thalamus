interface Vault {
    readonly id: string;
    readonly provider: string;
    add(name: string, credential: Credential): Promise<void>;
    update(name: string, credential: Credential): Promise<void>;
    remove(name: string): Promise<void>;
    list(): Promise<CredentialInfo[]>;
    destroy(): Promise<void>;
}
type Credential = {
    type: "bearer";
    token: string;
} | {
    type: "oauth";
    accessToken: string;
    expiresAt?: string;
    refresh?: OAuthRefreshConfig;
};
interface OAuthRefreshConfig {
    refreshToken: string;
    tokenEndpoint: string;
    clientId: string;
    clientSecret?: string;
    scopes?: string;
}
interface CredentialInfo {
    name: string;
    type: "bearer" | "oauth";
    status: "active" | "expired" | "error";
    expiresAt?: string;
    createdAt: string;
    updatedAt: string;
}
interface VaultOptions {
    name: string;
    metadata?: Record<string, string>;
}
interface VaultStore {
    createVault(options: VaultOptions): Promise<VaultRecord>;
    getVault(vaultId: string): Promise<VaultRecord | null>;
    updateVaultMetadata(vaultId: string, metadata: Record<string, string>): Promise<void>;
    removeVault(vaultId: string): Promise<void>;
    set(vaultId: string, name: string, credential: Credential): Promise<void>;
    get(vaultId: string, name: string): Promise<StoredCredential | null>;
    getAll(vaultId: string): Promise<StoredCredential[]>;
    remove(vaultId: string, name: string): Promise<void>;
}
interface VaultRecord {
    id: string;
    name: string;
    metadata?: Record<string, string>;
    createdAt: string;
}
interface StoredCredential {
    name: string;
    type: "bearer" | "oauth";
    credential: Credential;
    status: "active" | "expired" | "error";
    expiresAt?: string;
    createdAt: string;
    updatedAt: string;
}

export type { Credential as C, OAuthRefreshConfig as O, StoredCredential as S, Vault as V, CredentialInfo as a, VaultOptions as b, VaultStore as c, VaultRecord as d };
