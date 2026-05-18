export { O as OpenAIProviderConfig, c as createOpenAIProvider } from '../openai.provider-BIJRwsB0.cjs';
import { g as Message } from '../types-Dt6a3qIc.cjs';
import '../types-D5De32xL.cjs';
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

export { openaiTransformer };
