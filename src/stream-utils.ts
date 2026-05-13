import type { Response, StreamResult } from "./types";

/** @deprecated Use `await provider.stream(params)` instead. */
export async function collectStream(result: StreamResult): Promise<Response> {
  return result;
}
