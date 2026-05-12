export interface SigV4FetchOptions {
  region: string;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
}

/**
 * Creates a custom fetch function that signs requests with AWS SigV4.
 * Requires optional peer deps: @smithy/signature-v4, @aws-crypto/sha256-js
 */
export function createSigV4Fetch(
  options: SigV4FetchOptions,
): (input: any, init?: any) => Promise<any> {
  const { region, credentials } = options;

  return async (input: any, init?: any): Promise<any> => {
    let SignatureV4: any;
    let Sha256: any;
    try {
      SignatureV4 = (
        await import(/* webpackIgnore: true */ "@smithy/signature-v4")
      ).SignatureV4;
      Sha256 = (await import(/* webpackIgnore: true */ "@aws-crypto/sha256-js"))
        .Sha256;
    } catch {
      throw new Error(
        "SigV4 auth requires @smithy/signature-v4 and @aws-crypto/sha256-js. " +
          "Install them: pnpm add @smithy/signature-v4 @aws-crypto/sha256-js",
      );
    }

    const signer = new SignatureV4({
      service: "bedrock",
      region,
      credentials,
      sha256: Sha256,
    });

    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const body = init?.body ? String(init.body) : undefined;

    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers;
      if (
        typeof h === "object" &&
        h !== null &&
        typeof h.forEach === "function"
      ) {
        h.forEach((v: string, k: string) => {
          headers[k] = v;
        });
      } else if (Array.isArray(h)) {
        for (const [k, v] of h) headers[k] = v;
      } else {
        Object.assign(headers, h);
      }
    }

    const signed = await signer.sign({
      method: init?.method ?? "GET",
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port ? Number(url.port) : undefined,
      path: url.pathname + url.search,
      headers: { ...headers, host: url.host },
      body,
    });

    return globalThis.fetch(input, {
      ...init,
      headers: signed.headers,
    });
  };
}
