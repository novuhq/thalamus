export function makeStream(events: object[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e;
    },
  };
}

export const config = {
  apiKey: "sk-test",
  model: "gpt-4o",
  instructions: "Be helpful.",
};

export const bedrockConfig = {
  awsRegion: "us-east-1",
  awsBedrockApiKey: "bedrock-api-key-abc123",
  model: "openai.gpt-oss-120b",
  instructions: "Be helpful.",
};

export const sigv4Config = {
  awsRegion: "us-west-2",
  awsCredentials: {
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  },
  model: "openai.gpt-oss-120b",
};
