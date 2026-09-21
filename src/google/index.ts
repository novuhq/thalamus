export {
  assistantResourceName,
  createGoogleProvider,
  discoveryEngineEndpoint,
  type GoogleProviderConfig,
  type GoogleStreamAssist,
  mapGoogleError,
} from "./google.provider";
export {
  mapChunk as mapGoogleChunk,
  ResponseAccumulator as GoogleResponseAccumulator,
  type StreamAssistResponse,
} from "./google-parser";
