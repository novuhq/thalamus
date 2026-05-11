import Anthropic from '@anthropic-ai/sdk';
import { ThalamusError } from '../errors.js';
import { collectStream } from '../stream-utils.js';
import {
  ANTHROPIC,
  type RequestParams,
  type Provider,
  type Response,
  type StreamPart,
  type StreamResult,
  type Usage,
} from '../types.js';
import type {
  BetaManagedAgentsStreamSessionEvents,
  BetaManagedAgentsSessionStatusIdleEvent,
  BetaManagedAgentsAgentMessageEvent,
  BetaManagedAgentsAgentMCPToolUseEvent,
  BetaManagedAgentsAgentMCPToolResultEvent,
  BetaManagedAgentsSessionErrorEvent,
  BetaManagedAgentsSpanModelRequestEndEvent,
} from '@anthropic-ai/sdk/resources/beta/sessions';
import { toContentBlocks } from './anthropic.transformer.js';

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

class AnthropicProvider implements Provider {
  readonly provider = ANTHROPIC;
  readonly runtimeId: string;

  private readonly client: Anthropic;
  private readonly agentId: string;
  private readonly environmentId: string;

  constructor(config: { apiKey: string; agentId: string; environmentId: string }) {
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
      let sessionId: string;
      if (params.sessionId) {
        sessionId = params.sessionId;
      } else {
        const session = await this.client.beta.sessions.create({
          agent: this.agentId,
          environment_id: this.environmentId,
        });
        sessionId = session.id;
      }

      yield { type: 'stream-start', sessionId };

      const sseStream = await this.client.beta.sessions.events.stream(sessionId);

      await this.client.beta.sessions.events.send(sessionId, {
        events: [{ type: 'user.message', content: toContentBlocks(params.message.content) }],
      });

      let accumulatedContent = '';
      let finishReason: Response['finishReason'] = 'stop';
      let usage: Usage | undefined;

      for await (const rawEvent of sseStream) {
        const event = rawEvent as BetaManagedAgentsStreamSessionEvents;

        switch (event.type) {
          case 'agent.message': {
            const e = event as BetaManagedAgentsAgentMessageEvent;
            for (const block of e.content) {
              if (block.type === 'text') {
                accumulatedContent += block.text;
                yield { type: 'text-delta', text: block.text };
              }
            }
            break;
          }
          case 'agent.thinking': {
            yield { type: 'thinking', text: '' };
            break;
          }
          case 'agent.mcp_tool_use': {
            const e = event as BetaManagedAgentsAgentMCPToolUseEvent;
            yield { type: 'tool-use-start', toolName: e.name, toolUseId: e.id, input: e.input };
            break;
          }
          case 'agent.mcp_tool_result': {
            const e = event as BetaManagedAgentsAgentMCPToolResultEvent;
            const output = e.content?.find((b) => b.type === 'text');
            yield { type: 'tool-use-result', toolUseId: e.mcp_tool_use_id, output: output?.type === 'text' ? output.text : undefined };
            break;
          }
          case 'session.status_idle': {
            const e = event as BetaManagedAgentsSessionStatusIdleEvent;
            finishReason = mapStopReason(e.stop_reason);
            break;
          }
          case 'session.error': {
            const e = event as BetaManagedAgentsSessionErrorEvent;
            throw mapError(e.error);
          }
          case 'span.model_request_end': {
            const e = event as BetaManagedAgentsSpanModelRequestEndEvent;
            if (e.model_usage) {
              usage = {
                inputTokens: e.model_usage.input_tokens,
                outputTokens: e.model_usage.output_tokens,
                totalTokens: e.model_usage.input_tokens + e.model_usage.output_tokens,
              };
            }
            break;
          }
        }

        if (event.type === 'session.status_idle') break;
      }

      const response: Response = { content: accumulatedContent, sessionId, finishReason, usage };
      yield { type: 'finish', response };
      resolveResponse(response);
    } catch (err) {
      const error = err instanceof ThalamusError ? err : new ThalamusError(String(err), { provider: ANTHROPIC, isRetryable: false });
      yield { type: 'error', error };
      rejectResponse(error);
    }
  }

  async endSession(sessionId: string): Promise<void> {
    await this.client.beta.sessions.archive(sessionId);
  }
}

export function createAnthropicProvider(config: {
  apiKey: string;
  agentId: string;
  environmentId: string;
}): Provider {
  return new AnthropicProvider(config);
}
