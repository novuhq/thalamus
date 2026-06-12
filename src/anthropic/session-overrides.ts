import type {
  BetaManagedAgentsCustomToolInputSchema,
  BetaManagedAgentsCustomToolParams,
  BetaManagedAgentsMCPToolset,
  BetaManagedAgentsMCPToolsetParams,
  BetaManagedAgentsURLMCPServerParams,
} from "@anthropic-ai/sdk/resources/beta/agents/agents";
import type {
  BetaManagedAgentsSession,
  BetaManagedAgentsSessionAgentUpdate,
} from "@anthropic-ai/sdk/resources/beta/sessions/sessions";
import type {
  AgentSessionConfig,
  AgentToolConfig,
  McpServerConfig,
} from "../types";

type SessionAgentTool = BetaManagedAgentsSession["agent"]["tools"][number];

type SessionAgentToolParams = NonNullable<
  BetaManagedAgentsSessionAgentUpdate["tools"]
>[number];

function isMcpToolset(
  tool: SessionAgentTool,
): tool is BetaManagedAgentsMCPToolset {
  return tool.type === "mcp_toolset";
}

function toCustomToolParams(
  tool: AgentToolConfig,
): BetaManagedAgentsCustomToolParams {
  return {
    type: "custom",
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as BetaManagedAgentsCustomToolInputSchema,
  };
}

function toMcpToolsetParams(
  server: McpServerConfig,
): BetaManagedAgentsMCPToolsetParams {
  return { type: "mcp_toolset", mcp_server_name: server.name };
}

function toUrlMcpServerParams(
  server: McpServerConfig,
): BetaManagedAgentsURLMCPServerParams {
  return { type: "url", name: server.name, url: server.url };
}

/**
 * Map Thalamus session agent config + current session snapshot into an Anthropic
 * session agent update payload. Returns null when no overrides were requested.
 */
export function buildSessionAgentUpdate(
  agentConfig: AgentSessionConfig,
  session: BetaManagedAgentsSession,
): BetaManagedAgentsSessionAgentUpdate | null {
  const hasToolsOverride = agentConfig.tools || agentConfig.providerTools;
  const hasMcpOverride = !!agentConfig.mcpServers;

  if (!hasToolsOverride && !hasMcpOverride) return null;

  const currentTools = session.agent.tools;

  const nonMcpTools: SessionAgentToolParams[] = hasToolsOverride
    ? [
        ...((agentConfig.providerTools ??
          []) as unknown as SessionAgentToolParams[]),
        ...(agentConfig.tools ?? []).map(toCustomToolParams),
      ]
    : currentTools.filter((tool) => !isMcpToolset(tool));

  const mcpServers = agentConfig.mcpServers;
  const mcpToolsets: SessionAgentToolParams[] = mcpServers
    ? mcpServers.map(toMcpToolsetParams)
    : currentTools.filter(isMcpToolset);

  return {
    tools: [...nonMcpTools, ...mcpToolsets],
    mcp_servers: mcpServers
      ? mcpServers.map(toUrlMcpServerParams)
      : session.agent.mcp_servers,
  };
}
