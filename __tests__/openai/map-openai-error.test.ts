import { APIError, APIUserAbortError, RateLimitError } from "openai";
import { describe, expect, it } from "vitest";
import {
  AbortedError,
  ProviderRateLimitError,
  ProviderResponseError,
} from "../../src/errors.js";
import { mapOpenAIError } from "../../src/openai/index.js";
import { loadedOpenAI } from "../../src/openai/openai-client.js";

describe("mapOpenAIError before a client opens", () => {
  it("keeps abort and rate-limit classification without loading openai", () => {
    expect(loadedOpenAI()).toBeUndefined();

    const aborted = mapOpenAIError(new APIUserAbortError(), "openai");
    expect(aborted).toBeInstanceOf(AbortedError);
    expect(aborted.isRetryable).toBe(false);

    const rateLimited = mapOpenAIError(
      new RateLimitError(
        429,
        { code: "rate_limit_exceeded", message: "quota exceeded" },
        undefined,
        new Headers(),
      ),
      "openai",
    );
    expect(rateLimited).toBeInstanceOf(ProviderRateLimitError);
    expect(rateLimited.isRetryable).toBe(true);

    const apiError = mapOpenAIError(
      new APIError(
        429,
        { code: "rate_limit_exceeded", message: "quota exceeded" },
        undefined,
        new Headers(),
      ),
      "openai",
    );
    expect(apiError).toBeInstanceOf(ProviderRateLimitError);

    const unrelated = Object.assign(new Error("nope"), {
      code: "rate_limit_exceeded",
    });
    expect(mapOpenAIError(unrelated, "openai")).toBeInstanceOf(
      ProviderResponseError,
    );

    expect(loadedOpenAI()).toBeUndefined();
  });
});
