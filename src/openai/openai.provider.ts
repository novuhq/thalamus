import OpenAI from 'openai';
import type {
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';
import {
  ThalamusError,
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderResponseError,
  ProviderUnavailableError,
} from '../errors';
import { collectStream } from '../stream-utils';
import {
  OPENAI,
  type RequestParams,
  type Provider,
  type Response,
  type StreamPart,
  type StreamResult,
  type Usage,
} from '../types';
import { openaiTransformer } from './openai.transformer';

function mapError(error: unknown, provider: string): Error {
  const msg = error instanceof Error ? error.message : String(error);
  const code = (error as any)?.code ?? '';
  if (code === 'invalid_api_key' || msg.toLowerCase().includes('unauthorized')) {
    return new ProviderAuthError(msg, { provider, cause: error });
  }
  if (code === 'rate_limit_exceeded' || msg.toLowerCase().includes('rate limit')) {
    return new ProviderRateLimitError(msg, { provider, cause: error });
  }
  if (msg.toLowerCase().includes('unavailable') || msg.toLowerCase().includes('503')) {
    return new ProviderUnavailableError(msg, { provider, cause: error });
  }
  return new ProviderResponseError(msg, { provider, cause: error });
}

export interface OpenAIProviderConfig {
  apiKey: string;
  model?: string;
  promptId?: string;
  instructions?: string;
}

class ResponseAccumulator {
  content = '';
  sessionId: string | undefined;
  finishReason: Response['finishReason'] = 'stop';
  usage: Usage | undefined;

  toResponse(): Response {
    return {
      content: this.content,
      sessionId: this.sessionId,
      finishReason: this.finishReason,
      usage: this.usage,
    };
  }
}

function* mapEvent(
  event: ResponseStreamEvent,
  acc: ResponseAccumulator,
): Generator<StreamPart> {
  switch (event.type) {
    // --- lifecycle ---
    case 'response.created': {
      acc.sessionId = event.response.id;
      yield { type: 'stream-start', sessionId: acc.sessionId };
      break;
    }
    case 'response.in_progress': {
      yield { type: 'status-change', status: 'running' };
      break;
    }
    case 'response.completed': {
      if (event.response.usage) {
        acc.usage = {
          inputTokens: event.response.usage.input_tokens,
          outputTokens: event.response.usage.output_tokens,
          totalTokens: event.response.usage.total_tokens,
        };
      }
      if (!acc.content) {
        acc.content = event.response.output_text;
      }
      break;
    }
    case 'response.failed': {
      acc.finishReason = 'error';
      throw new ThalamusError(
        event.response.error?.message ?? 'Response failed',
        { provider: OPENAI, isRetryable: false },
      );
    }
    case 'response.incomplete': {
      acc.finishReason = 'length';
      break;
    }

    // --- text streaming ---
    case 'response.output_text.delta': {
      acc.content += event.delta;
      yield { type: 'text-delta', text: event.delta };
      break;
    }

    // --- reasoning / thinking ---
    case 'response.reasoning_summary_text.delta': {
      yield { type: 'thinking', text: event.delta };
      break;
    }

    // --- function / tool calls ---
    case 'response.output_item.done': {
      if (event.item.type === 'function_call') {
        yield {
          type: 'tool-use-start',
          toolName: event.item.name,
          toolUseId: event.item.call_id,
          input: JSON.parse(event.item.arguments || '{}'),
        };
      }
      break;
    }

    // --- error ---
    case 'error': {
      throw mapError(event, OPENAI);
    }

    // --- escape hatch for everything else ---
    default: {
      yield {
        type: 'provider-event',
        provider: OPENAI,
        event: event.type,
        data: event as unknown as Record<string, unknown>,
      };
      break;
    }
  }
}

class OpenAIProvider implements Provider {
  readonly provider = OPENAI;
  readonly runtimeId: string;

  private readonly client: OpenAI;
  private readonly model: string;
  private readonly instructions?: string;

  constructor(config: OpenAIProviderConfig) {
    this.runtimeId = config.promptId ?? 'inline';
    this.model = config.model ?? 'gpt-4o';
    this.instructions = config.instructions;
    this.client = new OpenAI({ apiKey: config.apiKey });
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

  private buildCreateParams(params: RequestParams): ResponseCreateParamsStreaming {
    const allMessages = params.sessionId
      ? [params.message]
      : [...(params.history ?? []), params.message];

    return {
      model: this.model,
      input: openaiTransformer.toInput(allMessages) as ResponseCreateParamsStreaming['input'],
      stream: true,
      ...(this.instructions ? { instructions: this.instructions } : {}),
      ...(params.sessionId ? { previous_response_id: params.sessionId } : {}),
      ...params.providerOptions,
    };
  }

  private async *runStream(
    params: RequestParams,
    resolveResponse: (r: Response) => void,
    rejectResponse: (e: unknown) => void,
  ): AsyncIterable<StreamPart> {
    try {
      const rawStream = await this.client.responses.create(this.buildCreateParams(params));
      const acc = new ResponseAccumulator();

      for await (const rawEvent of rawStream) {
        yield* mapEvent(rawEvent, acc);
      }

      const response = acc.toResponse();
      yield { type: 'finish', response };
      resolveResponse(response);
    } catch (err) {
      const mapped = err instanceof ThalamusError
        ? err
        : mapError(err, OPENAI) as Error;
      yield { type: 'error', error: mapped };
      rejectResponse(mapped);
    }
  }
}

export function createOpenAIProvider(config: OpenAIProviderConfig): Provider {
  return new OpenAIProvider(config);
}
