import { assert, it } from "@effect/vitest";
import { Result } from "effect";

import { parseAllowedOrigin, type OriginRefusalReason } from "./allowed-origin.ts";

function outcome(input: string) {
  return Result.match(parseAllowedOrigin(input), {
    onSuccess: (origin) => `accepted ${origin}`,
    onFailure: (reason) => reason,
  });
}

it("normalizes HTTPS origins and loopback HTTP origins", () => {
  const accepted: ReadonlyArray<readonly [string, string]> = [
    ["https://www.example.com", "https://www.example.com"],
    ["https://www.example.com/", "https://www.example.com"],
    ["  HTTPS://WWW.Example.COM:443/ ", "https://www.example.com"],
    ["https://shop.example.com:8443", "https://shop.example.com:8443"],
    ["https://例え.jp", "https://xn--r8jz45g.jp"],
    ["https://[2606:4700:4700::1111]", "https://[2606:4700:4700::1111]"],
    ["https://203.0.113.9", "https://203.0.113.9"],
    ["http://localhost:5173", "http://localhost:5173"],
    ["http://127.0.0.1:8080/", "http://127.0.0.1:8080"],
    ["http://127.1.2.3", "http://127.1.2.3"],
    ["http://[::1]:3000", "http://[::1]:3000"],
  ];
  assert.deepEqual(
    accepted.map(([input]) => [input, outcome(input)]),
    accepted.map(([input, origin]) => [input, `accepted ${origin}`]),
  );
});

it("refuses each value that is not an origin a browser sends", () => {
  const refused: ReadonlyArray<readonly [string, OriginRefusalReason]> = [
    ["", "invalid-origin"],
    ["www.example.com", "invalid-origin"],
    ["null", "invalid-origin"],
    [`https://${"a".repeat(2048)}.example.com`, "invalid-origin"],
    ["https://example.com.", "invalid-origin"],
    ["https://exa mple.com", "invalid-origin"],
    ["https://*.example.com", "wildcard"],
    ["*", "wildcard"],
    ["http://www.example.com", "not-https"],
    ["http://192.168.1.10:8080", "not-https"],
    ["http://app.localhost", "not-https"],
    ["ftp://example.com", "not-https"],
    ["chrome-extension://abcdefghijklmnop", "not-https"],
    ["https://user:secret@example.com", "credentials"],
    ["https://user@example.com", "credentials"],
    ["https://www.example.com/contact", "not-an-origin"],
    ["https://www.example.com/?", "not-an-origin"],
    ["https://www.example.com?page=1", "not-an-origin"],
    ["https://www.example.com#form", "not-an-origin"],
    ["https://www.example.com#", "not-an-origin"],
  ];
  assert.deepEqual(
    refused.map(([input]) => [input, outcome(input)]),
    refused.map(([input, reason]) => [input, reason]),
  );
});
