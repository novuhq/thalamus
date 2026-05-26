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

const CONTEXT_HEADER = "[Context]";
const MESSAGE_HEADER = "[Message]";

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

function toText(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text",
    )
    .map((part) => part.text)
    .join("\n");
}

/** Formats assistant/system rows as a delimited context block. */
function formatContext(messages: Message[]): string {
  const lines = messages.map(
    (m) =>
      `${m.role === MessageRole.SYSTEM ? "System" : "Assistant"}: ${toText(m.content)}`,
  );
  return `${CONTEXT_HEADER}\n${lines.join("\n")}`;
}

/** Anthropic sessions only accept user.message — pack context + user text into one. */
function packUserMessage(context: Message[], user: Message): ContentBlock[] {
  if (context.length === 0) return toContentBlocks(user.content);
  return [
    {
      type: "text",
      text: `${formatContext(context)}\n\n${MESSAGE_HEADER}\n${toText(user.content)}`,
    },
  ];
}

/**
 * Maps RequestParams.messages to Anthropic session send events.
 * Assistant/system rows are packed as context on the following user message.
 */
export function buildSendEvents(
  params: RequestParams,
): BetaManagedAgentsEventParams[] {
  const events: BetaManagedAgentsUserMessageEventParams[] = [];
  let context: Message[] = [];

  for (const msg of params.messages) {
    if (msg.role === MessageRole.USER) {
      events.push({
        type: "user.message",
        content: packUserMessage(context, msg),
      });
      context = [];
    } else if (
      msg.role === MessageRole.ASSISTANT ||
      msg.role === MessageRole.SYSTEM
    ) {
      context.push(msg);
    }
  }

  if (context.length > 0) {
    events.push({
      type: "user.message",
      content: [{ type: "text", text: formatContext(context) }],
    });
  }

  return events;
}
