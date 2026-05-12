export interface Vault {
  readonly id: string;
  readonly provider: string;

  add(name: string, credential: Credential): Promise<void>;
  update(name: string, credential: Credential): Promise<void>;
  remove(name: string): Promise<void>;
  list(): Promise<CredentialInfo[]>;
  destroy(): Promise<void>;
}

export type Credential =
  | { type: "bearer"; token: string }
  | {
      type: "oauth";
      accessToken: string;
      expiresAt?: string;
      refresh?: OAuthRefreshConfig;
    };

export interface OAuthRefreshConfig {
  refreshToken: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  scopes?: string;
}

export interface CredentialInfo {
  name: string;
  type: "bearer" | "oauth";
  status: "active" | "expired" | "error";
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface VaultOptions {
  name: string;
  metadata?: Record<string, string>;
}

export interface VaultStore {
  createVault(options: VaultOptions): Promise<VaultRecord>;
  getVault(vaultId: string): Promise<VaultRecord | null>;
  updateVaultMetadata(
    vaultId: string,
    metadata: Record<string, string>,
  ): Promise<void>;
  removeVault(vaultId: string): Promise<void>;

  set(vaultId: string, name: string, credential: Credential): Promise<void>;
  get(vaultId: string, name: string): Promise<StoredCredential | null>;
  getAll(vaultId: string): Promise<StoredCredential[]>;
  remove(vaultId: string, name: string): Promise<void>;
}

export interface VaultRecord {
  id: string;
  name: string;
  metadata?: Record<string, string>;
  createdAt: string;
}

export interface StoredCredential {
  name: string;
  type: "bearer" | "oauth";
  credential: Credential;
  status: "active" | "expired" | "error";
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}
