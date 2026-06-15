import type { AgentSessionConfig } from "../types";

/** Strip inline MCP credentials before persisting agent config in durable payloads. */
export function sanitizeAgentForSerialization(
  agent: AgentSessionConfig | undefined,
): AgentSessionConfig | undefined {
  if (!agent?.mcpServers?.length) return agent;

  return {
    ...agent,
    mcpServers: agent.mcpServers.map(
      ({ authorization: _authorization, ...server }) => server,
    ),
  };
}
