import type { StreamAssistResponse } from "../../src/google/google-parser.js";

export const config = {
  projectId: "test-project",
  engineId: "test-engine-123",
};

export const GE_SESSION =
  "projects/test-project/locations/global/collections/default_collection/engines/test-engine-123/sessions/sess-1";

export function replyText(text: string, thought = false): StreamAssistResponse {
  return {
    answer: {
      state: "IN_PROGRESS",
      replies: [
        {
          groundedContent: {
            content: { text, thought, role: "model" },
          },
        },
      ],
    },
  };
}

export function succeeded(
  session = GE_SESSION,
  extra?: StreamAssistResponse,
): StreamAssistResponse {
  return {
    ...extra,
    answer: {
      ...extra?.answer,
      state: "SUCCEEDED",
    },
    sessionInfo: { session },
  };
}

export async function* streamOf(
  ...chunks: StreamAssistResponse[]
): AsyncIterable<StreamAssistResponse> {
  for (const chunk of chunks) yield chunk;
}
