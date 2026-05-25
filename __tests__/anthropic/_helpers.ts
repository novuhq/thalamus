export function mockSse(events: object[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e;
    },
  };
}

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

export const awsSigV4Config = {
  agentId: "agent_abc",
  environmentId: "env_xyz",
  awsRegion: "us-west-2",
  awsCredentials: {
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  },
};
