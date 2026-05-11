export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

export interface AnthropicImageBlock {
  type: 'image';
  source:
    | { type: 'base64'; media_type: string; data: string }
    | { type: 'url'; url: string }
    | { type: 'file'; file_id: string };
}

export interface AnthropicDocumentBlock {
  type: 'document';
  source:
    | { type: 'base64'; media_type: string; data: string }
    | { type: 'text'; data: string }
    | { type: 'url'; url: string }
    | { type: 'file'; file_id: string };
  title?: string | null;
  context?: string | null;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicDocumentBlock;

/** Discriminated union for `session.status_idle` stop_reason. */
export type AnthropicStopReason =
  | { type: 'end_turn' }
  | { type: 'requires_action'; event_ids: string[] }
  | { type: 'retries_exhausted' };

/** Typed error object from `session.error` events. */
export interface AnthropicSessionError {
  type: string;
  message: string;
  retry_status?: 'auto_retry' | 'exhausted' | 'none';
}

export interface AnthropicModelUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  speed?: 'standard' | 'fast' | null;
}

/**
 * Events received from the Anthropic managed agents SSE stream.
 * Typed against @anthropic-ai/sdk BetaManagedAgentsSessionEvent.
 */
export type AnthropicSessionEvent =
  | { type: 'agent.message'; id: string; content: AnthropicTextBlock[] }
  | { type: 'agent.thinking'; id: string }
  | {
      type: 'agent.mcp_tool_use';
      id: string;
      name: string;
      mcp_server_name: string;
      input: Record<string, unknown>;
      evaluated_permission?: 'allow' | 'ask' | 'deny';
      session_thread_id?: string | null;
    }
  | {
      type: 'agent.mcp_tool_result';
      id: string;
      mcp_tool_use_id: string;
      content?: AnthropicContentBlock[];
      is_error?: boolean | null;
    }
  | {
      type: 'agent.tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
      evaluated_permission?: 'allow' | 'ask' | 'deny';
      session_thread_id?: string | null;
    }
  | {
      type: 'agent.tool_result';
      id: string;
      tool_use_id: string;
      content?: AnthropicContentBlock[];
      is_error?: boolean | null;
    }
  | { type: 'agent.custom_tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'session.status_idle'; id: string; stop_reason: AnthropicStopReason }
  | { type: 'session.status_running'; id: string }
  | { type: 'session.status_rescheduled'; id: string }
  | { type: 'session.status_terminated'; id: string }
  | { type: 'session.error'; id: string; error: AnthropicSessionError }
  | { type: 'span.model_request_end'; id: string; model_usage: AnthropicModelUsage }
  | { type: 'span.model_request_start'; id: string }
  | { type: string; [key: string]: unknown };
