import type {
  BetaManagedAgentsAgentMCPToolResultEvent,
  BetaManagedAgentsAgentToolResultEvent,
  BetaManagedAgentsDocumentBlock,
  BetaManagedAgentsImageBlock,
  BetaManagedAgentsTextBlock,
} from "@anthropic-ai/sdk/resources/beta/sessions";
import type { ToolResultContent } from "../types";

/** Content block on `agent.tool_result` / `agent.mcp_tool_result` (SDK 0.98+). */
export type AnthropicToolResultContentBlock = NonNullable<
  BetaManagedAgentsAgentToolResultEvent["content"]
>[number];

function mapImageBlock(block: BetaManagedAgentsImageBlock): ToolResultContent {
  const { source } = block;
  if (source.type === "base64") {
    return {
      type: "media",
      mediaType: source.media_type,
      data: source.data,
    };
  }
  if (source.type === "url") {
    return {
      type: "media",
      mediaType: "image/*",
      data: source.url,
      name: source.url,
    };
  }
  return {
    type: "unknown",
    providerType: "image",
    data: block as unknown as Record<string, unknown>,
  };
}

function mapDocumentBlock(
  block: BetaManagedAgentsDocumentBlock,
): ToolResultContent {
  const { source } = block;
  if (source.type === "base64") {
    return {
      type: "media",
      mediaType: source.media_type,
      data: source.data,
      name: block.title ?? undefined,
    };
  }
  if (source.type === "text") {
    return { type: "text", text: source.data };
  }
  if (source.type === "url") {
    return {
      type: "media",
      mediaType: "application/octet-stream",
      data: source.url,
      name: block.title ?? source.url,
    };
  }
  return {
    type: "unknown",
    providerType: "document",
    data: block as unknown as Record<string, unknown>,
  };
}

export function parseAnthropicToolResultContent(
  blocks: readonly AnthropicToolResultContentBlock[] | null | undefined,
): ToolResultContent[] {
  if (!blocks?.length) return [];

  return blocks.flatMap((block): ToolResultContent[] => {
    switch (block.type) {
      case "text":
        return [{ type: "text", text: block.text }];
      case "search_result": {
        const excerpts = block.content.map((c) => c.text).filter(Boolean);
        return [
          {
            type: "citation",
            url: block.source,
            title: block.title,
            excerpts: excerpts.length > 0 ? excerpts : undefined,
          },
        ];
      }
      case "image":
        return [mapImageBlock(block)];
      case "document":
        return [mapDocumentBlock(block)];
      default:
        return [
          {
            type: "unknown",
            providerType: (block as { type: string }).type,
            data: block as unknown as Record<string, unknown>,
          },
        ];
    }
  });
}

export function toolResultFromAgentToolResultEvent(
  event: Pick<
    BetaManagedAgentsAgentToolResultEvent,
    "content" | "is_error" | "tool_use_id"
  >,
): { content: ToolResultContent[]; isError?: boolean } {
  return {
    content: parseAnthropicToolResultContent(event.content),
    isError: event.is_error ? true : undefined,
  };
}

export function toolResultFromMcpToolResultEvent(
  event: Pick<
    BetaManagedAgentsAgentMCPToolResultEvent,
    "content" | "is_error" | "mcp_tool_use_id"
  >,
): { content: ToolResultContent[]; isError?: boolean } {
  return {
    content: parseAnthropicToolResultContent(event.content),
    isError: event.is_error ? true : undefined,
  };
}

/** Thalamus {@link ToolResultContent} → plain string for provider APIs that only accept text. */
export function flattenToolResultText(content: ToolResultContent[]): string {
  const parts: string[] = [];
  for (const block of content) {
    switch (block.type) {
      case "text":
        if (block.text) parts.push(block.text);
        break;
      case "citation": {
        const head = block.title
          ? block.url
            ? `[${block.title}](${block.url})`
            : block.title
          : block.url;
        const excerpt = block.excerpts?.[0];
        parts.push(excerpt ? `${head}: ${excerpt}` : head);
        break;
      }
      case "json":
        parts.push(JSON.stringify(block.value));
        break;
      case "media":
        parts.push(block.name ?? `[${block.mediaType}]`);
        break;
      case "unknown":
        parts.push(JSON.stringify(block.data));
        break;
    }
  }
  return parts.join("\n\n");
}

/** Map unified content back for `user.custom_tool_result`. */
export function toAnthropicToolResultContent(
  content: ToolResultContent[],
): BetaManagedAgentsTextBlock[] {
  return [{ type: "text", text: flattenToolResultText(content) }];
}
