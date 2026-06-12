import { describe, expect, it } from "vitest";
import { sanitizeAgentForSerialization } from "../../src/durable/serialize-agent.js";

describe("sanitizeAgentForSerialization", () => {
  it("returns undefined when agent is undefined", () => {
    expect(sanitizeAgentForSerialization(undefined)).toBeUndefined();
  });

  it("returns agent unchanged when there are no mcpServers", () => {
    const agent = {
      tools: [
        {
          name: "lookup",
          description: "Look up",
          inputSchema: { type: "object" },
        },
      ],
    };
    expect(sanitizeAgentForSerialization(agent)).toBe(agent);
  });

  it("strips authorization from mcpServers", () => {
    const agent = {
      mcpServers: [
        {
          name: "github",
          url: "https://api.githubcopilot.com/mcp/",
          authorization: "ghp_secret",
          allowedTools: ["search_repos"],
        },
      ],
    };

    expect(sanitizeAgentForSerialization(agent)).toEqual({
      mcpServers: [
        {
          name: "github",
          url: "https://api.githubcopilot.com/mcp/",
          allowedTools: ["search_repos"],
        },
      ],
    });
  });

  it("does not mutate the original agent", () => {
    const agent = {
      mcpServers: [
        {
          name: "github",
          url: "https://api.githubcopilot.com/mcp/",
          authorization: "ghp_secret",
        },
      ],
    };

    sanitizeAgentForSerialization(agent);

    expect(agent.mcpServers[0].authorization).toBe("ghp_secret");
  });
});
