import { describe, expect, it } from "vitest";

import { networkFailure, RondyrClient, RondyrError } from "./rondyr-client.ts";

const token = `rdr_${"C".repeat(43)}`;

describe("networkFailure", () => {
  it("keeps only the category of a failed request", () => {
    expect(networkFailure(new DOMException("The operation timed out", "TimeoutError"))).toBe(
      "timeout",
    );
    expect(networkFailure(new DOMException("Aborted", "AbortError"))).toBe("timeout");
    expect(
      networkFailure(
        new Error('Plugin "rondyr" is not allowed to fetch from host "rondyr.example.com".'),
      ),
    ).toBe("host-refused");
    expect(
      networkFailure(new Error('Plugin "rondyr": blocked fetch to "localhost": private address')),
    ).toBe("host-refused");
    expect(networkFailure(new TypeError("fetch failed"))).toBe("network");
    expect(networkFailure(null)).toBe("network");
  });
});

describe("RondyrClient.submit", () => {
  it("answers with a category, never the error's text", async () => {
    const client = new RondyrClient(
      async (_url, init) => {
        throw new TypeError(`Invalid header: ${new Headers(init?.headers).get("authorization")}`);
      },
      "https://rondyr.example.com",
      token,
    );
    const result = await client.submit("public-id", { message: "Private text" }, "key");
    expect(result).toEqual({ status: null, reason: "network" });
  });

  it("passes redirect: manual and returns a 3xx status without following redirects", async () => {
    const redirects: (RequestRedirect | undefined)[] = [];
    const client = new RondyrClient(
      async (_url, init) => {
        redirects.push(init?.redirect);
        return new Response(null, {
          status: 302,
          headers: { location: "https://other.example.com/steal" },
        });
      },
      "https://rondyr.example.com",
      token,
    );
    const result = await client.submit("public-id", { message: "Hello" }, "key");
    expect(redirects).toEqual(["manual"]);
    expect(result).toEqual({ status: 302, submissionId: null });
  });
});

describe("RondyrClient API calls", () => {
  it("passes redirect: manual and rejects 3xx responses as unexpected", async () => {
    const redirects: (RequestRedirect | undefined)[] = [];
    const client = new RondyrClient(
      async (_url, init) => {
        redirects.push(init?.redirect);
        return new Response(null, {
          status: 307,
          headers: { location: "https://other.example.com/steal" },
        });
      },
      "https://rondyr.example.com",
      token,
    );
    await expect(client.organization()).rejects.toEqual(new RondyrError("unexpected"));
    expect(redirects).toEqual(["manual"]);
  });
});
