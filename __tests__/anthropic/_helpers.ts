export function mockSse(events: object[]) {
  return {
    controller: new AbortController(),
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e;
    },
  };
}

/** `events.list` for a session with no prior events. */
export const emptyHistory = async () => mockSse([]);

export const config = {
  apiKey: "sk-test",
  agentId: "agent_abc",
  environmentId: "env_xyz",
};

export const awsConfig = {
  agentId: "agent_abc",
  environmentId: "env_xyz",
  awsRegion: "us-east-1",
  apiKey: "aws-api-key-abc123",
};
