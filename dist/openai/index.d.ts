export { O as OpenAIProviderConfig, c as createOpenAIProvider } from '../openai.provider-7YTQfjrV.js';
import { g as Message } from '../types-D03ofbVu.js';
import '../types-Dj7j5_Vh.js';
import '../vault.interface-BMCawAU1.js';

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
