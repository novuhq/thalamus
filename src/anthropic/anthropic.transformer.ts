import type {
  BetaManagedAgentsDocumentBlock,
  BetaManagedAgentsEventParams,
  BetaManagedAgentsImageBlock,
  BetaManagedAgentsTextBlock,
  BetaManagedAgentsUserMessageEventParams,
} from "@anthropic-ai/sdk/resources/beta/sessions";
import type { Message, RequestParams } from "../types";
import { MessageRole } from "../types";

type ContentBlock =
  | BetaManagedAgentsTextBlock
  | BetaManagedAgentsImageBlock
  | BetaManagedAgentsDocumentBlock;

/**
 * Converts a Message's content to Anthropic content blocks.
 */
export function toContentBlocks(content: Message["content"]): ContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  const blocks: ContentBlock[] = [];
  for (const part of content) {
    switch (part.type) {
      case "text":
        blocks.push({ type: "text", text: part.text });
        break;
      case "image":
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: part.mediaType,
            data: part.data,
          },
        });
        break;
      case "image-url":
        blocks.push({ type: "image", source: { type: "url", url: part.url } });
        break;
      case "file":
        blocks.push({
          type: "document",
          source: {
            type: "base64",
            media_type: part.mediaType,
            data: part.data,
          },
          title: part.name ?? null,
        });
        break;
    }
  }

  return blocks;
}

function warnIgnoredNonUserMessages(count: number): void {
  console.warn(
    `[@novu/thalamus] Anthropic sessions only accept user messages as input. ` +
      `Dropped ${count} assistant/system message(s). ` +
      `Use sessionId for continuity or embed prior context in a user message.`,
  );
}

/**
 * Maps RequestParams.messages to Anthropic session send events.
 * Only USER messages become user.message events (one per message, in order).
 * Assistant/system rows are not replayable on the sessions API and are dropped.
 */
export function buildSendEvents(
  params: RequestParams,
): BetaManagedAgentsEventParams[] {
  const userMessages = params.messages.filter(
    (msg) => msg.role === MessageRole.USER,
  );
  const ignoredCount = params.messages.length - userMessages.length;

  if (ignoredCount > 0) {
    warnIgnoredNonUserMessages(ignoredCount);
  }

  return userMessages.map(
    (msg): BetaManagedAgentsUserMessageEventParams => ({
      type: "user.message",
      content: toContentBlocks(msg.content),
    }),
  );
}
