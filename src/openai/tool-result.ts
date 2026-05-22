import { flattenToolResultText } from "../anthropic/tool-result";
import type { ToolResultContent } from "../types";

export function parseOpenAIToolResultOutput(
  output: string | null | undefined,
): ToolResultContent[] {
  if (output == null || output === "") return [];
  return [{ type: "text", text: output }];
}

export function toOpenAIToolResultOutput(content: ToolResultContent[]): string {
  return flattenToolResultText(content);
}
