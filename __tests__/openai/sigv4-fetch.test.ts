import { afterEach, describe, expect, it, vi } from "vitest";
import { createSigV4Fetch } from "../../src/openai/sigv4-fetch.js";

const mockSign = vi.fn();

vi.mock("@smithy/signature-v4", () => ({
  SignatureV4: class {
    constructor(public opts: any) {}
    sign = mockSign;
  },
}));

vi.mock("@aws-crypto/sha256-js", () => ({
  Sha256: class FakeSha256 {},
}));

const fetchSpy = vi
  .spyOn(globalThis, "fetch")
  .mockResolvedValue(new Response("ok"));

afterEach(() => vi.clearAllMocks());

const creds = {
  accessKeyId: "AKID",
  secretAccessKey: "SECRET",
  sessionToken: "TOKEN",
};

describe("createSigV4Fetch", () => {
  it("signs the request and passes signed headers to globalThis.fetch", async () => {
    mockSign.mockResolvedValue({
      headers: { authorization: "AWS4-HMAC-SHA256 ..." },
    });

    const sigFetch = createSigV4Fetch({
      region: "us-east-1",
      credentials: creds,
    });
    await sigFetch("https://bedrock.us-east-1.amazonaws.com/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"input":"hi"}',
    });

    expect(mockSign).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        hostname: "bedrock.us-east-1.amazonaws.com",
        path: "/v1/responses",
        headers: expect.objectContaining({
          "content-type": "application/json",
          host: "bedrock.us-east-1.amazonaws.com",
        }),
        body: '{"input":"hi"}',
      }),
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://bedrock.us-east-1.amazonaws.com/v1/responses",
      expect.objectContaining({
        headers: { authorization: "AWS4-HMAC-SHA256 ..." },
      }),
    );
  });

  it("defaults method to GET when not provided", async () => {
    mockSign.mockResolvedValue({ headers: {} });

    const sigFetch = createSigV4Fetch({
      region: "us-west-2",
      credentials: creds,
    });
    await sigFetch("https://example.com/path");

    expect(mockSign).toHaveBeenCalledWith(
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("normalizes Headers instance (forEach style)", async () => {
    mockSign.mockResolvedValue({ headers: {} });

    const headers = new Headers();
    headers.set("x-custom", "value");

    const sigFetch = createSigV4Fetch({
      region: "us-east-1",
      credentials: creds,
    });
    await sigFetch("https://example.com/", { headers });

    expect(mockSign).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({ "x-custom": "value" }),
      }),
    );
  });

  it("includes query string in the signed path", async () => {
    mockSign.mockResolvedValue({ headers: {} });

    const sigFetch = createSigV4Fetch({
      region: "us-east-1",
      credentials: creds,
    });
    await sigFetch("https://example.com/api?foo=bar&baz=1");

    expect(mockSign).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/api?foo=bar&baz=1" }),
    );
  });
});
