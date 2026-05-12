import type Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC } from "../types";
import type {
  Credential,
  CredentialInfo,
  Vault,
} from "../vault/vault.interface";

export class AnthropicVault implements Vault {
  readonly id: string;
  readonly provider = ANTHROPIC;

  private readonly client: Anthropic;

  constructor(id: string, client: Anthropic) {
    this.id = id;
    this.client = client;
  }

  private toAuth(
    name: string,
    credential: Credential,
  ): Record<string, unknown> {
    if (credential.type === "bearer") {
      return {
        type: "static_bearer",
        mcp_server_url: name,
        token: credential.token,
      };
    }

    return {
      type: "mcp_oauth",
      mcp_server_url: name,
      access_token: credential.accessToken,
      expires_at: credential.expiresAt,
      ...(credential.refresh && {
        refresh_token: credential.refresh.refreshToken,
        token_endpoint: credential.refresh.tokenEndpoint,
        client_id: credential.refresh.clientId,
        client_secret: credential.refresh.clientSecret,
        scope: credential.refresh.scopes,
      }),
    };
  }

  async add(name: string, credential: Credential): Promise<void> {
    await (this.client.beta as any).vaults.credentials.create(this.id, {
      display_name: name,
      auth: this.toAuth(name, credential),
    });
  }

  async update(name: string, credential: Credential): Promise<void> {
    await this.remove(name);
    await this.add(name, credential);
  }

  async remove(name: string): Promise<void> {
    const result = await (this.client.beta as any).vaults.credentials.list(
      this.id,
    );
    const match = (result.data ?? []).find((c: any) => c.display_name === name);
    if (!match) {
      throw new Error(`Credential "${name}" not found in vault ${this.id}`);
    }
    await (this.client.beta as any).vaults.credentials.delete(
      this.id,
      match.id,
    );
  }

  async list(): Promise<CredentialInfo[]> {
    const result = await (this.client.beta as any).vaults.credentials.list(
      this.id,
    );
    return (result.data ?? []).map((c: any) => ({
      name: c.display_name,
      type: c.auth?.type === "static_bearer" ? "bearer" : "oauth",
      status: "active" as const,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
    }));
  }

  async destroy(): Promise<void> {
    await (this.client.beta as any).vaults.delete(this.id);
  }
}
