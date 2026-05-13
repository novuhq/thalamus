import type Anthropic from "@anthropic-ai/sdk";
import type {
  BetaManagedAgentsCredential,
  BetaManagedAgentsMCPOAuthCreateParams,
  BetaManagedAgentsStaticBearerCreateParams,
  CredentialCreateParams,
} from "@anthropic-ai/sdk/resources/beta/vaults/credentials";
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
  private readonly agentId: string;

  constructor(id: string, client: Anthropic, agentId: string) {
    this.id = id;
    this.client = client;
    this.agentId = agentId;
  }

  private async resolveMcpServerUrl(name: string): Promise<string> {
    const agent = await this.client.beta.agents.retrieve(this.agentId);
    const server = (agent.mcp_servers ?? []).find((s) => s.name === name);
    if (!server) {
      const available = (agent.mcp_servers ?? []).map((s) => s.name).join(", ");
      throw new Error(
        `No MCP server named "${name}" on agent ${this.agentId}. Available: ${available}`,
      );
    }
    return server.url;
  }

  private toAuth(
    serverUrl: string,
    credential: Credential,
  ): CredentialCreateParams["auth"] {
    if (credential.type === "bearer") {
      const auth: BetaManagedAgentsStaticBearerCreateParams = {
        type: "static_bearer",
        mcp_server_url: serverUrl,
        token: credential.token,
      };
      return auth;
    }

    const auth: BetaManagedAgentsMCPOAuthCreateParams = {
      type: "mcp_oauth",
      mcp_server_url: serverUrl,
      access_token: credential.accessToken,
      ...(credential.expiresAt ? { expires_at: credential.expiresAt } : {}),
      ...(credential.refresh && {
        refresh: {
          refresh_token: credential.refresh.refreshToken,
          token_endpoint: credential.refresh.tokenEndpoint,
          client_id: credential.refresh.clientId,
          token_endpoint_auth: credential.refresh.clientSecret
            ? {
                type: "client_secret_basic" as const,
                client_secret: credential.refresh.clientSecret,
              }
            : { type: "none" as const },
          scope: credential.refresh.scopes,
        },
      }),
    };
    return auth;
  }

  async add(name: string, credential: Credential): Promise<void> {
    const url = await this.resolveMcpServerUrl(name);
    await this.client.beta.vaults.credentials.create(this.id, {
      display_name: name,
      auth: this.toAuth(url, credential),
    });
  }

  async update(name: string, credential: Credential): Promise<void> {
    await this.remove(name);
    await this.add(name, credential);
  }

  async remove(name: string): Promise<void> {
    const creds: BetaManagedAgentsCredential[] = [];
    for await (const c of this.client.beta.vaults.credentials.list(this.id)) {
      creds.push(c);
    }
    const match = creds.find((c) => c.display_name === name);
    if (!match) {
      throw new Error(`Credential "${name}" not found in vault ${this.id}`);
    }
    await this.client.beta.vaults.credentials.delete(match.id, {
      vault_id: this.id,
    });
  }

  async list(): Promise<CredentialInfo[]> {
    const result: CredentialInfo[] = [];
    for await (const c of this.client.beta.vaults.credentials.list(this.id)) {
      result.push({
        name: c.display_name ?? "",
        type: c.auth?.type === "static_bearer" ? "bearer" : "oauth",
        status: "active" as const,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
      });
    }
    return result;
  }

  async destroy(): Promise<void> {
    await this.client.beta.vaults.delete(this.id);
  }
}
