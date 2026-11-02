import OpenAI from "openai";
import { ThalamusError } from "../errors";
import { OPENAI } from "../types";
import type { OpenAIProviderConfig } from "./openai.provider";

export type ResolvedAuth =
  | { kind: "direct"; apiKey: string }
  | { kind: "bedrock-api-key"; region: string; apiKey: string }
  | {
      kind: "bedrock-sigv4";
      region: string;
      credentials: {
        accessKeyId: string;
        secretAccessKey: string;
        sessionToken?: string;
      };
    };

export type OpenedClient = { client: OpenAI; authorization: string };

function isDirectConfig(
  config: OpenAIProviderConfig,
): config is OpenAIProviderConfig & { apiKey: string } {
  return !("awsRegion" in config) || !config.awsRegion;
}

export function resolveAuth(config: OpenAIProviderConfig): ResolvedAuth {
  if (isDirectConfig(config)) {
    return { kind: "direct", apiKey: config.apiKey };
  }

  if ("awsBedrockApiKey" in config && config.awsBedrockApiKey) {
    return {
      kind: "bedrock-api-key",
      region: config.awsRegion,
      apiKey: config.awsBedrockApiKey,
    };
  }

  if ("awsCredentials" in config && config.awsCredentials) {
    return {
      kind: "bedrock-sigv4",
      region: config.awsRegion,
      credentials: config.awsCredentials,
    };
  }

  throw new ThalamusError(
    "Bedrock requires awsBedrockApiKey or awsCredentials",
    { provider: OPENAI, isRetryable: false },
  );
}

export async function openOpenAIClient(
  auth: ResolvedAuth,
): Promise<OpenedClient> {
  // null stops the SDK from reading AWS_BEDROCK_BASE_URL
  const baseURL = null;

  switch (auth.kind) {
    case "direct": {
      const { apiKey } = auth;
      return {
        client: new OpenAI({ apiKey }),
        authorization: `Bearer ${apiKey}`,
      };
    }
    case "bedrock-api-key": {
      const { region, apiKey } = auth;
      let imported: typeof import("openai/providers/bedrock");
      try {
        imported = await import("openai/providers/bedrock");
      } catch (err) {
        throw new ThalamusError(
          "Amazon Bedrock bearer auth requires openai >= 6.45.0",
          { provider: OPENAI, isRetryable: false, cause: err },
        );
      }
      const { bedrock } = imported;
      return {
        client: new OpenAI({
          provider: bedrock({
            region,
            apiKey,
            baseURL,
          }),
        }),
        authorization: `Bearer ${apiKey}`,
      };
    }
    case "bedrock-sigv4": {
      const { region, credentials } = auth;
      let imported: typeof import("openai/providers/bedrock/aws");
      try {
        imported = await import("openai/providers/bedrock/aws");
      } catch (err) {
        throw new ThalamusError(
          "SigV4 auth requires @aws-sdk/credential-provider-node, @smithy/hash-node, and @smithy/signature-v4",
          { provider: OPENAI, isRetryable: false, cause: err },
        );
      }
      const { bedrock } = imported;
      const { accessKeyId, secretAccessKey, sessionToken } = credentials;
      return {
        client: new OpenAI({
          provider: bedrock({
            region,
            accessKeyId,
            secretAccessKey,
            sessionToken,
            baseURL,
          }),
        }),
        authorization: "Bearer bedrock-sigv4",
      };
    }
    default: {
      const unreachable: never = auth;
      throw unreachable;
    }
  }
}
