import Anthropic from '@anthropic-ai/sdk';
import { ThalamusError } from '../errors';
import { collectStream } from '../stream-utils';
import {
  ANTHROPIC,
  type ActionRequired,
  type RequestParams,
  type Provider,
  type Response,
  type StreamPart,
  type StreamResult,
  type Usage,
} from '../types';
import type {
  BetaManagedAgentsStreamSessionEvents,
  BetaManagedAgentsSessionStatusIdleEvent,
  BetaManagedAgentsAgentMessageEvent,
  BetaManagedAgentsAgentToolUseEvent,
  BetaManagedAgentsAgentToolResultEvent,
  BetaManagedAgentsAgentMCPToolUseEvent,
  BetaManagedAgentsAgentMCPToolResultEvent,
  BetaManagedAgentsAgentCustomToolUseEvent,
  BetaManagedAgentsSessionErrorEvent,
  BetaManagedAgentsSpanModelRequestEndEvent,
} from '@anthropic-ai/sdk/resources/beta/sessions';
import { toContentBlocks } from './anthropic.transformer';

type StopReason = BetaManagedAgentsSessionStatusIdleEvent['stop_reason'];

function mapStopReason(reason: StopReason): Response['finishReason'] {
  switch (reason.type) {
    case 'end_turn': return 'stop';
    case 'requires_action': return 'requires-action';
    case 'retries_exhausted': return 'error';
    default: return 'other';
  }
}

function mapError(raw: unknown): ThalamusError {
  const obj = raw as { message?: string; type?: string } | null;
  const msg = obj?.message ?? String(raw);
  const isAuth = obj?.type === 'authentication_error';
  return new ThalamusError(msg, { provider: ANTHROPIC, isRetryable: !isAuth });
}

class ResponseAccumulator {
  content = '';
  finishReason: Response['finishReason'] = 'stop';
  usage: Usage | undefined;
  actionsRequired: ActionRequired[] = [];
  done = false;

  toResponse(sessionId: string): Response {
    return {
      content: this.content,
      sessionId,
      finishReason: this.finishReason,
      usage: this.usage,
      actionsRequired: this.actionsRequired.length > 0 ? this.actionsRequired : undefined,
    };
  }
}

function* mapEvent(
  event: BetaManagedAgentsStreamSessionEvents,
  acc: ResponseAccumulator,
): Generator<StreamPart> {
  switch (event.type) {
    // --- text streaming ---
    case 'agent.message': {
      const e = event as BetaManagedAgentsAgentMessageEvent;
      for (const block of e.content) {
        if (block.type === 'text') {
          acc.content += block.text;
          yield { type: 'text-delta', text: block.text };
        }
      }
      break;
    }

    // --- reasoning / thinking ---
    case 'agent.thinking': {
      yield { type: 'thinking', text: '' };
      break;
    }

    // --- tool calls ---
    case 'agent.tool_use': {
      const e = event as BetaManagedAgentsAgentToolUseEvent;
      yield { type: 'tool-use-done', toolName: e.name, toolUseId: e.id, input: e.input };
      break;
    }
    case 'agent.tool_result': {
      const e = event as BetaManagedAgentsAgentToolResultEvent;
      const output = e.content?.find((b) => b.type === 'text');
      yield { type: 'tool-use-result', toolUseId: e.tool_use_id, output: output?.type === 'text' ? output.text : undefined };
      break;
    }
    case 'agent.mcp_tool_use': {
      const e = event as BetaManagedAgentsAgentMCPToolUseEvent;
      yield { type: 'tool-use-done', toolName: e.name, toolUseId: e.id, input: e.input };
      break;
    }
    case 'agent.mcp_tool_result': {
      const e = event as BetaManagedAgentsAgentMCPToolResultEvent;
      const output = e.content?.find((b) => b.type === 'text');
      yield { type: 'tool-use-result', toolUseId: e.mcp_tool_use_id, output: output?.type === 'text' ? output.text : undefined };
      break;
    }
    case 'agent.custom_tool_use': {
      const e = event as BetaManagedAgentsAgentCustomToolUseEvent;
      acc.actionsRequired.push({
        type: 'tool-confirmation',
        toolUseId: e.id,
        toolName: e.name,
        input: e.input as Record<string, unknown>,
      });
      acc.finishReason = 'requires-action';
      break;
    }

    // --- lifecycle ---
    case 'session.status_running': {
      yield { type: 'status-change', status: 'running' };
      break;
    }
    case 'session.status_rescheduled': {
      yield { type: 'status-change', status: 'retrying' };
      break;
    }
    case 'session.status_idle': {
      const e = event as BetaManagedAgentsSessionStatusIdleEvent;
      yield { type: 'status-change', status: 'idle' };
      acc.finishReason = mapStopReason(e.stop_reason);
      acc.done = true;
      break;
    }
    case 'session.status_terminated': {
      throw new ThalamusError('Session terminated', { provider: ANTHROPIC, isRetryable: false });
    }

    // --- error ---
    case 'session.error': {
      const e = event as BetaManagedAgentsSessionErrorEvent;
      throw mapError(e.error);
    }
    // --- usage ---
    case 'span.model_request_end': {
      const e = event as BetaManagedAgentsSpanModelRequestEndEvent;
      if (e.model_usage) {
        acc.usage = {
          inputTokens: e.model_usage.input_tokens,
          outputTokens: e.model_usage.output_tokens,
          totalTokens: e.model_usage.input_tokens + e.model_usage.output_tokens,
        };
      }
      break;
    }

    // --- escape hatch for everything else ---
    default: {
      yield { type: 'provider-event', provider: ANTHROPIC, event: event.type, data: event as unknown as Record<string, unknown> };
      break;
    }
  }
}

export interface AnthropicProviderConfig {
  apiKey: string;
  agentId: string;
  environmentId: string;
}

class AnthropicProvider implements Provider {
  readonly provider = ANTHROPIC;
  readonly runtimeId: string;

  private readonly client: Anthropic;
  private readonly agentId: string;
  private readonly environmentId: string;

  constructor(config: AnthropicProviderConfig) {
    this.agentId = config.agentId;
    this.environmentId = config.environmentId;
    this.runtimeId = config.agentId;
    this.client = new Anthropic({ apiKey: config.apiKey });
  }

  async send(params: RequestParams): Promise<Response> {
    return collectStream(await this.stream(params));
  }

  async stream(params: RequestParams): Promise<StreamResult> {
    let resolveResponse!: (r: Response) => void;
    let rejectResponse!: (e: unknown) => void;
    const responsePromise = new Promise<Response>((res, rej) => {
      resolveResponse = res;
      rejectResponse = rej;
    });
    return { stream: this.runStream(params, resolveResponse, rejectResponse), response: responsePromise };
  }

  private async *runStream(
    params: RequestParams,
    resolveResponse: (r: Response) => void,
    rejectResponse: (e: unknown) => void,
  ): AsyncIterable<StreamPart> {
    try {
      const sessionId = params.sessionId ?? (await this.createSession());

      yield { type: 'stream-start', sessionId };

      const sseStream = await this.client.beta.sessions.events.stream(sessionId);
      await this.client.beta.sessions.events.send(sessionId, {
        events: [{
          type: 'user.message' as const,
          content: params.messages.flatMap((msg) => toContentBlocks(msg.content)),
        }],
      });

      const acc = new ResponseAccumulator();

      for await (const rawEvent of sseStream) {
        yield* mapEvent(rawEvent as BetaManagedAgentsStreamSessionEvents, acc);
        if (acc.done) break;
      }

      const response = acc.toResponse(sessionId);
      yield { type: 'finish', response };
      resolveResponse(response);
    } catch (err) {
      const error = err instanceof ThalamusError ? err : new ThalamusError(String(err), { provider: ANTHROPIC, isRetryable: false });
      yield { type: 'error', error };
      rejectResponse(error);
    }
  }

  private async createSession(): Promise<string> {
    const session = await this.client.beta.sessions.create({
      agent: this.agentId,
      environment_id: this.environmentId,
    });

    return session.id;
  }

}

export function createAnthropicProvider(config: AnthropicProviderConfig): Provider {
  return new AnthropicProvider(config);
}
