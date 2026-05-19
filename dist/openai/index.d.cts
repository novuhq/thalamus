export { O as OpenAIProviderConfig, c as createOpenAIProvider } from '../openai.provider-BvbMfJyr.cjs';
import { g as Message, i as Response, U as Usage, c as ActionRequired, S as StreamPart } from '../types-D5jxkcf8.cjs';
import { ResponseStreamEvent } from 'openai/resources/responses/responses';
import '../types-BJUMp1Dw.cjs';
import '../vault.interface-BMCawAU1.cjs';

type OpenAIInputContent = {
    type: "input_text";
    text: string;
} | {
    type: "input_image";
    image_url: string;
} | {
    type: "input_file";
    file_data: string;
    filename?: string;
};
type OpenAIInputMessage = {
    role: "user" | "system" | "assistant";
    content: string | OpenAIInputContent[];
};
declare const openaiTransformer: {
    toInput(messages: Message[]): OpenAIInputMessage[];
};

declare function mapError(error: unknown, provider: string): Error;
declare class ResponseAccumulator {
    content: string;
    sessionId: string | undefined;
    conversationId: string | undefined;
    finishReason: Response["finishReason"];
    usage: Usage | undefined;
    actionsRequired: ActionRequired[];
    toResponse(): Response;
}
declare function mapEvent(event: ResponseStreamEvent, acc: ResponseAccumulator): Generator<StreamPart>;

export { ResponseAccumulator as OpenAIResponseAccumulator, mapError as mapOpenAIError, mapEvent as mapOpenAIEvent, openaiTransformer };
