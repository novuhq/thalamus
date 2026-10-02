/** Why a live text stream ended. */
export type LiveEndReason = "complete" | "interrupted" | "aborted";

/** One SSE event on the edge observer's `/live` stream. */
export type LiveEvent =
  | { type: "text"; text: string }
  | { type: "end"; reason: LiveEndReason };

export interface LiveOptions {
  signal?: AbortSignal;
}

/** Serializes one live event as an SSE frame (`event:` + JSON `data:`). */
export function encodeLiveEvent(event: LiveEvent): string {
  const { type, ...data } = event;
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function parseFrame(frame: string): LiveEvent | undefined {
  let type = "";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") type = value;
    else if (field === "data") data.push(value);
  }
  if ((type !== "text" && type !== "end") || data.length === 0) return;
  return { ...JSON.parse(data.join("\n")), type };
}

/** Reads live events from an SSE body. Comments and unknown events are skipped. */
export async function* readLiveEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<LiveEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(
        /\r\n/g,
        "\n",
      );
      for (let end = buffer.indexOf("\n\n"); end !== -1; ) {
        const event = parseFrame(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (event) yield event;
        end = buffer.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
