import { describe, expect, it } from "vitest";

import { verifyWebhook } from "./signature.ts";

const encoder = new TextEncoder();
const secret = "whsec_test-secret";
const now = Date.UTC(2026, 10, 21, 12);
const timestamp = String(Math.floor(now / 1000));
const body = encoder.encode('{"version":1,"type":"test","note":"é"}');

async function sign(key: string, stamp: string, bytes: Uint8Array) {
  const hmac = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const message = new Uint8Array([...encoder.encode(`${stamp}.`), ...bytes]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", hmac, message));
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function headers(signature: string, stamp = timestamp) {
  return new Headers({ "rondyr-timestamp": stamp, "rondyr-signature": signature });
}

describe("verifyWebhook", () => {
  it("accepts a valid signature over the exact bytes", async () => {
    const signature = await sign(secret, timestamp, body);
    expect(await verifyWebhook(body, headers(`v1=${signature}`), secret, now)).toBe("valid");
  });

  it("accepts either of two signatures during a rotation", async () => {
    const current = await sign(secret, timestamp, body);
    const previous = await sign("whsec_previous", timestamp, body);
    const header = `v1=${previous},v1=${current}`;
    expect(await verifyWebhook(body, headers(header), secret, now)).toBe("valid");
    expect(await verifyWebhook(body, headers(header), "whsec_previous", now)).toBe("valid");
  });

  it("refuses another secret, a changed body and a malformed header", async () => {
    const signature = await sign(secret, timestamp, body);
    expect(await verifyWebhook(body, headers(`v1=${signature}`), "whsec_other", now)).toBe(
      "invalid-signature",
    );
    const changed = encoder.encode('{"version":1,"type":"test","note":"e"}');
    expect(await verifyWebhook(changed, headers(`v1=${signature}`), secret, now)).toBe(
      "invalid-signature",
    );
    expect(await verifyWebhook(body, headers(signature), secret, now)).toBe("invalid-signature");
    expect(await verifyWebhook(body, headers(`v1=${signature}`, "soon"), secret, now)).toBe(
      "invalid-signature",
    );
  });

  it("refuses a timestamp more than five minutes away", async () => {
    const old = String(Math.floor(now / 1000) - 301);
    const signature = await sign(secret, old, body);
    expect(await verifyWebhook(body, headers(`v1=${signature}`, old), secret, now)).toBe(
      "stale-timestamp",
    );
    const edge = String(Math.floor(now / 1000) - 300);
    const valid = await sign(secret, edge, body);
    expect(await verifyWebhook(body, headers(`v1=${valid}`, edge), secret, now)).toBe("valid");
  });
});
