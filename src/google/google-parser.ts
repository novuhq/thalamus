import type { protos } from "@google-cloud/discoveryengine";
import type { StreamPart, Response as ThalamusResponse } from "../types";

export type StreamAssistResponse =
  protos.google.cloud.discoveryengine.v1beta.IStreamAssistResponse;

const STATE = {
  IN_PROGRESS: 1,
  FAILED: 2,
  SUCCEEDED: 3,
  SKIPPED: 4,
} as const;

const BUILTIN = { type: "builtin" as const };

export class ResponseAccumulator {
  messages: string[] = [];
  sessionId: string | undefined;
  finishReason: ThalamusResponse["finishReason"] = "stop";
  done = false;
  text = "";
  emittedTools = new Set<string>();

  toResponse(): ThalamusResponse {
    return {
      messages: this.messages,
      sessionId: this.sessionId,
      finishReason: this.finishReason,
    };
  }
}

function skippedMessage(reasons: unknown): string {
  const values = Array.isArray(reasons) ? reasons.map(String) : [];
  if (values.includes("NON_ASSIST_SEEKING_QUERY_IGNORED")) {
    return "Gemini Enterprise ignored that as a greeting, not a question. Ask something specific.";
  }
  if (values.length > 0) {
    return `Gemini Enterprise skipped this message (${values.join(", ")}).`;
  }

  return "Gemini Enterprise skipped this message.";
}

function answerState(state: unknown): string {
  if (typeof state === "string") return state;
  if (state === STATE.IN_PROGRESS) return "IN_PROGRESS";
  if (state === STATE.FAILED) return "FAILED";
  if (state === STATE.SUCCEEDED) return "SUCCEEDED";
  if (state === STATE.SKIPPED) return "SKIPPED";
  return "STATE_UNSPECIFIED";
}

function* emitTool(
  acc: ResponseAccumulator,
  toolName: string,
  input?: Record<string, unknown>,
): Generator<StreamPart> {
  if (acc.emittedTools.has(toolName)) return;
  acc.emittedTools.add(toolName);
  const toolUseId = crypto.randomUUID();
  yield {
    type: "tool-use-start",
    toolName,
    toolUseId,
    source: BUILTIN,
  };
  yield {
    type: "tool-use-done",
    toolName,
    toolUseId,
    input,
    source: BUILTIN,
  };
}

/**
 * Maps one `streamAssist` proto chunk to StreamParts.
 * Text: `answer.replies[].groundedContent.content.text` (skip `thought: true`).
 * Tools: `invocationTools`, `invokedSkills`, and web-grounding references.
 */
export function* mapChunk(
  chunk: StreamAssistResponse,
  acc: ResponseAccumulator,
): Generator<StreamPart> {
  if (chunk.sessionInfo?.session) {
    acc.sessionId = chunk.sessionInfo.session;
  }

  for (const name of chunk.invocationTools ?? []) {
    if (name) yield* emitTool(acc, name);
  }
  for (const skill of chunk.invokedSkills ?? []) {
    const name = skill.displayName ?? skill.name;
    if (name) yield* emitTool(acc, name);
  }

  for (const reply of chunk.answer?.replies ?? []) {
    const grounded = reply.groundedContent;
    const content = grounded?.content;
    if (content?.text && !content.thought) {
      acc.text += content.text;
      yield { type: "text-delta", text: content.text };
    }

    const refs = grounded?.textGroundingMetadata?.references ?? [];
    if (refs.length) {
      const sources = refs
        .map((ref) => ref.documentMetadata?.title ?? ref.documentMetadata?.uri)
        .filter((value): value is string => !!value);
      yield* emitTool(acc, "web_grounding", { sources });
    }
  }

  const state = answerState(chunk.answer?.state);
  if (state === "SUCCEEDED") {
    if (acc.text) {
      acc.messages.push(acc.text);
      yield { type: "message", text: acc.text };
    }
    acc.finishReason = "stop";
    acc.done = true;
  } else if (state === "SKIPPED") {
    const reasons = chunk.answer?.assistSkippedReasons ?? [];
    const skippedText = skippedMessage(reasons);
    acc.messages.push(skippedText);
    yield { type: "message", text: skippedText };
    acc.finishReason = "stop";
    acc.done = true;
  } else if (state === "FAILED") {
    acc.finishReason = "error";
    acc.done = true;
  }
}
