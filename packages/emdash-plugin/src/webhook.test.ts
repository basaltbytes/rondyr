import { describe, expect, it } from "vitest";

import { Store } from "./store.ts";
import { memoryHost } from "./testing/memory-storage.ts";
import { receiveWebhook } from "./webhook.ts";

const encoder = new TextEncoder();
const secret = "whsec_site-secret";
const now = Date.UTC(2026, 10, 21, 12);
const deliveryId = "1b4e28ba-2fa1-4d2b-883f-0016d3cca427";

function payload(type = "submission.accepted") {
  return encoder.encode(
    JSON.stringify({
      version: 1,
      type,
      deliveryId,
      submission: {
        id: "73123ee4-40bf-4c5f-b8ff-1d56cdaa7640",
        receivedAt: "2026-11-21T11:59:00.000Z",
        fields: { name: "Ada", email: "ada@example.com", message: "Is there room?" },
      },
      form: { id: "rondyr-contact", name: "Rondyr contact" },
    }),
  );
}

async function signed(body: Uint8Array, key = secret, at = now) {
  const timestamp = String(Math.floor(at / 1000));
  const hmac = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const message = new Uint8Array([...encoder.encode(`${timestamp}.`), ...body]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", hmac, message));
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return new Headers({ "rondyr-timestamp": timestamp, "rondyr-signature": `v1=${hex}` });
}

async function site(failing: ReadonlySet<string> = new Set()) {
  const { host } = memoryHost();
  const sent: { to: string; subject: string; text: string; replyTo?: string }[] = [];
  const store = new Store(host);
  await store.putLink("contact", {
    rondyrFormId: "rondyr-contact",
    recipients: ["team@example.com", "owner@example.com"],
  });
  await store.putLayout({
    slug: "contact",
    name: "Contact",
    fields: [
      { name: "name", label: "Your name", type: "text" },
      { name: "email", label: "Email", type: "email" },
      { name: "message", label: "Message", type: "textarea" },
    ],
  });
  const email = {
    send: async (message: { to: string; subject: string; text: string; replyTo?: string }) => {
      if (failing.has(message.to)) throw new Error("Mailer refused");
      sent.push(message);
    },
  };
  return { host, email, sent };
}

describe("receiveWebhook", () => {
  it("emails every recipient of the linked form, in the forms plugin's format", async () => {
    const { host, email, sent } = await site();
    const body = payload();
    const outcome = await receiveWebhook(
      { ...host, email, input: body, request: { headers: await signed(body) } },
      secret,
      now,
    );
    expect(outcome).toEqual({ status: 200, emailed: 2 });
    expect(sent.map(({ to }) => to)).toEqual(["team@example.com", "owner@example.com"]);
    expect(sent[0]).toMatchObject({
      subject: "New submission: Contact",
      replyTo: "ada@example.com",
      text: [
        'New submission for "Contact"',
        "",
        "Your name: Ada",
        "Email: ada@example.com",
        "Message: Is there room?",
        "",
        "Submitted at: 2026-11-21T11:59:00.000Z",
      ].join("\n"),
    });
  });

  it("sends nothing for a wrong signature, an old timestamp or a seen delivery ID", async () => {
    const { host, email, sent } = await site();
    const body = payload();
    const context = (headers: Headers) => ({ ...host, email, input: body, request: { headers } });

    const wrong = await receiveWebhook(context(await signed(body, "whsec_other")), secret, now);
    expect(wrong).toEqual({ status: 401, code: "invalid-signature" });
    const old = await receiveWebhook(
      context(await signed(body, secret, now - 301_000)),
      secret,
      now,
    );
    expect(old).toEqual({ status: 401, code: "stale-timestamp" });
    expect(sent).toEqual([]);

    expect(await receiveWebhook(context(await signed(body)), secret, now)).toEqual({
      status: 200,
      emailed: 2,
    });
    const again = await receiveWebhook(context(await signed(body)), secret, now);
    expect(again).toEqual({ status: 200, emailed: 0 });
    expect(sent).toHaveLength(2);
  });

  it("answers a test request without email", async () => {
    const { host, email, sent } = await site();
    const body = payload("test");
    const outcome = await receiveWebhook(
      { ...host, email, input: body, request: { headers: await signed(body) } },
      secret,
      now,
    );
    expect(outcome).toEqual({ status: 200, emailed: 0 });
    expect(sent).toEqual([]);
  });

  it("asks Rondyr to retry when an email fails, then skips the recipients already emailed", async () => {
    const failing = new Set(["owner@example.com"]);
    const { host, email, sent } = await site(failing);
    const body = payload();
    const context = async () => ({
      ...host,
      email,
      input: body,
      request: { headers: await signed(body) },
    });
    expect(await receiveWebhook(await context(), secret, now)).toEqual({
      status: 503,
      code: "EMAIL_FAILED",
    });
    failing.clear();
    expect(await receiveWebhook(await context(), secret, now)).toEqual({ status: 200, emailed: 1 });
    expect(sent.map(({ to }) => to)).toEqual(["team@example.com", "owner@example.com"]);
  });

  it("refuses every request without the secret, so Rondyr retries", async () => {
    const { host, email } = await site();
    const body = payload();
    const outcome = await receiveWebhook(
      { ...host, email, input: body, request: { headers: await signed(body) } },
      null,
      now,
    );
    expect(outcome).toEqual({ status: 503, code: "NOT_CONFIGURED" });
  });
});
