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

  async add(name: string, credential: Credential): Promise<void> {
    if (credential.type === "bearer") {
      await (this.client.beta as any).vaults.credentials.create(this.id, {
        display_name: name,
        auth: {
          type: "static_bearer",
          mcp_server_url: name,
          token: credential.token,
        },
      });
    } else {
      const auth: Record<string, unknown> = {
        type: "mcp_oauth",
        mcp_server_url: name,
        access_token: credential.accessToken,
        expires_at: credential.expiresAt,
      };
      if (credential.refresh) {
        auth.refresh = {
          refresh_token: credential.refresh.refreshToken,
          token_endpoint: credential.refresh.tokenEndpoint,
          client_id: credential.refresh.clientId,
          client_secret: credential.refresh.clientSecret,
          scope: credential.refresh.scopes,
        };
      }
      await (this.client.beta as any).vaults.credentials.create(this.id, {
        display_name: name,
        auth,
      });
    }
  }

  async update(name: string, credential: Credential): Promise<void> {
    await this.remove(name);
    await this.add(name, credential);
  }

  async remove(_name: string): Promise<void> {
    // Anthropic credentials are identified by ID, not name.
    // Full implementation requires listing + matching by display_name.
    throw new Error("Not yet implemented: credential removal by name");
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
