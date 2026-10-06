import type {
  BetaManagedAgentsAgent,
  BetaManagedAgentsCustomToolInputSchema,
  BetaManagedAgentsCustomToolParams,
  BetaManagedAgentsMCPToolset,
  BetaManagedAgentsMCPToolsetParams,
  BetaManagedAgentsURLMCPServerParams,
} from "@anthropic-ai/sdk/resources/beta/agents/agents";
import type {
  BetaManagedAgentsAgentWithOverridesParams,
  BetaManagedAgentsSessionAgentUpdate,
} from "@anthropic-ai/sdk/resources/beta/sessions/sessions";
import type {
  AgentSessionConfig,
  AgentToolConfig,
  McpServerConfig,
} from "../types";

/** The tool config an override is applied on top of: an agent or a session's agent snapshot. */
type AgentToolsSnapshot = Pick<BetaManagedAgentsAgent, "tools" | "mcp_servers">;

type SessionAgentTool = AgentToolsSnapshot["tools"][number];

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
 * Map Thalamus session agent config + current tool config into an Anthropic
 * session agent update payload. Returns null when no overrides were requested.
 */
export function buildSessionAgentUpdate(
  agentConfig: AgentSessionConfig,
  current: AgentToolsSnapshot,
): BetaManagedAgentsSessionAgentUpdate | null {
  const hasToolsOverride = agentConfig.tools || agentConfig.providerTools;
  const hasMcpOverride = !!agentConfig.mcpServers;

  if (!hasToolsOverride && !hasMcpOverride) return null;

  const currentTools = current.tools;

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
      : current.mcp_servers,
  };
}

/**
 * Session-create `agent` param applying the overrides natively, pinned to the
 * agent version they were computed against. Returns null when no overrides
 * were requested.
 */
export function buildAgentWithOverrides(
  agentConfig: AgentSessionConfig,
  agent: BetaManagedAgentsAgent,
): BetaManagedAgentsAgentWithOverridesParams | null {
  const update = buildSessionAgentUpdate(agentConfig, agent);
  if (!update) return null;

  return {
    type: "agent_with_overrides",
    id: agent.id,
    version: agent.version,
    ...update,
  };
}
