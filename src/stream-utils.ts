import type { Response, StreamResult } from "./types";

export async function collectStream(result: StreamResult): Promise<Response> {
  for await (const _part of result.stream) {
    // Drive the generator to completion so the response promise resolves.
  }
  return result.response;
}
