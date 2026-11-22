import { describe, expect, it, vi } from "vitest";

import { newEntry } from "./core/queue.ts";
import { attempt } from "./delivery.ts";
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

interface Sent {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly replyTo?: string;
}

async function site(failing: ReadonlySet<string> = new Set()) {
  const { host, lines } = memoryHost();
  const sent: Sent[] = [];
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
    send: async (message: Sent) => {
      if (failing.has(message.to)) throw new Error(`Mailer refused ${message.text}`);
      sent.push(message);
    },
  };
  return { host, email, sent, lines };
}

describe("receiveWebhook", () => {
  it("emails every recipient of the linked form, in the forms plugin's format", async () => {
    const { host, email, sent } = await site();
    const body = payload();
    const outcome = await receiveWebhook(
      { ...host, email, input: body, request: { headers: await signed(body) } },
      [secret],
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

    const wrong = await receiveWebhook(context(await signed(body, "whsec_other")), [secret], now);
    expect(wrong).toEqual({ status: 401, code: "invalid-signature" });
    const old = await receiveWebhook(
      context(await signed(body, secret, now - 301_000)),
      [secret],
      now,
    );
    expect(old).toEqual({ status: 401, code: "stale-timestamp" });
    expect(sent).toEqual([]);

    expect(await receiveWebhook(context(await signed(body)), [secret], now)).toEqual({
      status: 200,
      emailed: 2,
    });
    const again = await receiveWebhook(context(await signed(body)), [secret], now);
    expect(again).toEqual({ status: 200, emailed: 0 });
    expect(sent).toHaveLength(2);
  });

  it("accepts the secret of any of the site's Rondyr webhooks", async () => {
    const { host, email, sent } = await site();
    const body = payload();
    const context = { ...host, email, input: body, request: { headers: await signed(body) } };
    const secrets = ["whsec_another-form", secret];
    expect(await receiveWebhook(context, secrets, now)).toEqual({ status: 200, emailed: 2 });
    expect(sent).toHaveLength(2);
    const stale = { ...context, request: { headers: await signed(body, secret, now - 301_000) } };
    expect(await receiveWebhook(stale, secrets, now)).toEqual({
      status: 401,
      code: "stale-timestamp",
    });
  });

  it("answers a test request without email", async () => {
    const { host, email, sent } = await site();
    const body = payload("test");
    const outcome = await receiveWebhook(
      { ...host, email, input: body, request: { headers: await signed(body) } },
      [secret],
      now,
    );
    expect(outcome).toEqual({ status: 200, emailed: 0 });
    expect(sent).toEqual([]);
  });

  it("asks Rondyr to retry when an email fails, then skips the recipients already emailed", async () => {
    const failing = new Set(["owner@example.com"]);
    const { host, email, sent, lines } = await site(failing);
    const body = payload();
    const context = async () => ({
      ...host,
      email,
      input: body,
      request: { headers: await signed(body) },
    });
    expect(await receiveWebhook(await context(), [secret], now)).toEqual({
      status: 503,
      code: "EMAIL_FAILED",
    });
    failing.clear();
    expect(await receiveWebhook(await context(), [secret], now)).toEqual({
      status: 200,
      emailed: 1,
    });
    expect(sent.map(({ to }) => to)).toEqual(["team@example.com", "owner@example.com"]);
    // The log names the delivery and the form, never the message or a recipient.
    expect(lines).toEqual([
      {
        level: "error",
        message: "Failed to send a Rondyr notification",
        data: { deliveryId, form: "contact" },
      },
    ]);
  });

  it("answers 503 to a second request while the first one sends the emails", async () => {
    const { host, email, sent } = await site();
    const slow = Promise.withResolvers<void>();
    const sending = Promise.withResolvers<void>();
    const held = {
      send: async (message: Sent) => {
        sending.resolve();
        await slow.promise;
        await email.send(message);
      },
    };
    const body = payload();
    const headers = await signed(body);
    const first = receiveWebhook(
      { ...host, email: held, input: body, request: { headers } },
      [secret],
      now,
    );
    await sending.promise;
    const second = await receiveWebhook(
      { ...host, email, input: body, request: { headers } },
      [secret],
      now + 1_000,
    );
    expect(second).toEqual({ status: 503, code: "DELIVERY_IN_PROGRESS" });
    slow.resolve();
    expect(await first).toEqual({ status: 200, emailed: 2 });
    expect(sent.map(({ to }) => to)).toEqual(["team@example.com", "owner@example.com"]);
  });

  it("emails only the remaining recipients after a request that stopped midway", async () => {
    const { host, email, sent } = await site();
    const stuck = {
      send: async (message: Sent) => {
        // The Worker stops while the second email is with the mailer.
        if (message.to === "owner@example.com") await new Promise(() => {});
        await email.send(message);
      },
    };
    const body = payload();
    void receiveWebhook(
      { ...host, email: stuck, input: body, request: { headers: await signed(body) } },
      [secret],
      now,
    );
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const later = now + 5 * 60_000;
    const retry = await receiveWebhook(
      { ...host, email, input: body, request: { headers: await signed(body, secret, later) } },
      [secret],
      later,
    );
    expect(retry).toEqual({ status: 200, emailed: 1 });
    expect(sent.map(({ to }) => to)).toEqual(["team@example.com", "owner@example.com"]);
  });

  it("refuses every request without the secret, so Rondyr retries", async () => {
    const { host, email } = await site();
    const body = payload();
    const outcome = await receiveWebhook(
      { ...host, email, input: body, request: { headers: await signed(body) } },
      [],
      now,
    );
    expect(outcome).toEqual({ status: 503, code: "NOT_CONFIGURED" });
  });
});

const submissionId = "6f0e2a4b-8c1d-4e3f-9a5b-7c6d8e9f0a1b";
const sentAt = "2026-11-21T11:59:00.000Z";
const options = { url: "https://rondyr.example.com" };
const token = `rdr_${"T".repeat(43)}`;

/** A message sent from the French form: its field names are the French form's. */
function frenchMessage(receivedAt = sentAt) {
  return encoder.encode(
    JSON.stringify({
      version: 1,
      type: "submission.accepted",
      deliveryId,
      submission: {
        id: submissionId,
        receivedAt,
        fields: { nom: "Ada", courriel: "ada@example.com", message: "Reste-t-il de la place ?" },
      },
      form: { id: "rondyr-contact", name: "Rondyr contact" },
    }),
  );
}

/** `contact-en` and `contact-fr`, the same form in two languages, both linked to `rondyr-contact`. */
async function bilingualSite(recipients: {
  readonly en: readonly string[];
  readonly fr: readonly string[];
}) {
  const { host, collections, lines } = memoryHost();
  const store = new Store(host);
  await store.putLink("contact-en", {
    rondyrFormId: "rondyr-contact",
    recipients: [...recipients.en],
  });
  await store.putLink("contact-fr", {
    rondyrFormId: "rondyr-contact",
    recipients: [...recipients.fr],
  });
  await store.putLayout({
    slug: "contact-en",
    name: "Contact us",
    fields: [
      { name: "name", label: "Your name", type: "text" },
      { name: "email", label: "Email", type: "email", required: true },
      { name: "message", label: "Message", type: "textarea" },
    ],
  });
  await store.putLayout({
    slug: "contact-fr",
    name: "Nous écrire",
    fields: [
      { name: "nom", label: "Votre nom", type: "text" },
      { name: "courriel", label: "Courriel", type: "email", required: true },
      { name: "message", label: "Votre message", type: "textarea" },
    ],
  });
  const sent: Sent[] = [];
  const failing = new Set<string>();
  const email = {
    send: async (message: Sent) => {
      if (failing.has(message.to)) throw new Error("Mailer refused");
      sent.push(message);
    },
  };
  const deliver = async (body: Uint8Array, at = now) =>
    receiveWebhook(
      { ...host, email, input: body, request: { headers: await signed(body, secret, at) } },
      [secret],
      at,
    );
  return { host, store, collections, lines, sent, failing, deliver };
}

/** The French form's message goes through the queue: Rondyr answers `202` with its ID. */
async function sendThroughQueue(host: Parameters<typeof attempt>[0], formSlug: string) {
  const store = new Store(host);
  const entryId = crypto.randomUUID();
  await store.createQueueEntry(entryId, newEntry(formSlug, { nom: "Ada" }, now - 60_000));
  const http = {
    fetch: async () =>
      Response.json({ "submission-id": submissionId, status: "received" }, { status: 202 }),
  };
  expect(await attempt({ ...host, http }, options, token, entryId, () => now - 60_000)).toBe(
    "sent",
  );
}

const frenchText = [
  'New submission for "Nous écrire"',
  "",
  "Votre nom: Ada",
  "Courriel: ada@example.com",
  "Votre message: Reste-t-il de la place ?",
  "",
  `Submitted at: ${sentAt}`,
].join("\n");

describe("receiveWebhook with several EmDash forms on one Rondyr form", () => {
  it("emails an address listed on both forms once, with the layout of the form used", async () => {
    const shared = await bilingualSite({ en: ["team@example.com"], fr: ["team@example.com"] });
    await sendThroughQueue(shared.host, "contact-fr");
    expect(await shared.deliver(frenchMessage())).toEqual({ status: 200, emailed: 1 });
    expect(shared.sent).toEqual([
      {
        to: "team@example.com",
        subject: "New submission: Nous écrire",
        replyTo: "ada@example.com",
        text: frenchText,
      },
    ]);
  });

  it("emails only the recipients of the form the message came from", async () => {
    const shared = await bilingualSite({
      en: ["sales@example.com", "team@example.com"],
      fr: ["equipe@example.com"],
    });
    await sendThroughQueue(shared.host, "contact-fr");
    expect(await shared.deliver(frenchMessage())).toEqual({ status: 200, emailed: 1 });
    expect(shared.sent.map(({ to, subject }) => ({ to, subject }))).toEqual([
      { to: "equipe@example.com", subject: "New submission: Nous écrire" },
    ]);
  });

  it("emails every linked form's recipients once, with the first form's layout, when the origin is unknown", async () => {
    const shared = await bilingualSite({
      en: ["team@example.com", "sales@example.com"],
      fr: ["Team@Example.com", "equipe@example.com"],
    });
    expect(await shared.deliver(frenchMessage())).toEqual({ status: 200, emailed: 3 });
    expect(shared.sent.map(({ to }) => to)).toEqual([
      "team@example.com",
      "sales@example.com",
      "equipe@example.com",
    ]);
    // `contact-en` comes first by slug. Its layout doesn't know the French fields,
    // which keep their names, and it has no filled email field for Reply-To.
    expect(shared.sent[0]).toEqual({
      to: "team@example.com",
      subject: "New submission: Contact us",
      text: [
        'New submission for "Contact us"',
        "",
        "Message: Reste-t-il de la place ?",
        "nom: Ada",
        "courriel: ada@example.com",
        "",
        `Submitted at: ${sentAt}`,
      ].join("\n"),
    });
  });

  it("treats a form linked to another Rondyr form since as an unknown origin", async () => {
    const shared = await bilingualSite({ en: ["team@example.com"], fr: ["equipe@example.com"] });
    await sendThroughQueue(shared.host, "contact-fr");
    await shared.store.putLink("contact-fr", {
      rondyrFormId: "rondyr-other",
      recipients: ["equipe@example.com"],
    });
    expect(await shared.deliver(frenchMessage())).toEqual({ status: 200, emailed: 1 });
    expect(shared.sent.map(({ to }) => to)).toEqual(["team@example.com"]);
  });

  it("emails only the remaining addresses when Rondyr retries after a partial send", async () => {
    const shared = await bilingualSite({
      en: ["team@example.com", "sales@example.com"],
      fr: ["TEAM@example.com", "equipe@example.com"],
    });
    shared.failing.add("sales@example.com");
    expect(await shared.deliver(frenchMessage())).toEqual({ status: 503, code: "EMAIL_FAILED" });
    shared.failing.clear();
    const later = now + 60_000;
    expect(await shared.deliver(frenchMessage(), later)).toEqual({ status: 200, emailed: 1 });
    expect(shared.sent.map(({ to }) => to)).toEqual([
      "team@example.com",
      "equipe@example.com",
      "sales@example.com",
    ]);
    expect(shared.lines).toEqual([
      {
        level: "error",
        message: "Failed to send a Rondyr notification",
        data: { deliveryId, form: "contact-en" },
      },
    ]);
  });

  it("skips the addresses of a delivery record written before, keyed by form", async () => {
    const shared = await bilingualSite({
      en: ["team@example.com"],
      fr: ["team@example.com", "equipe@example.com"],
    });
    await sendThroughQueue(shared.host, "contact-fr");
    // The previous version emailed `contact-en`'s recipient, then stopped.
    await shared.collections.deliveries.put(deliveryId, {
      receivedAt: now - 120_000,
      sent: ["contact-en:Team@Example.com"],
      done: false,
      heldUntil: 0,
    });
    expect(await shared.deliver(frenchMessage())).toEqual({ status: 200, emailed: 1 });
    expect(shared.sent.map(({ to }) => to)).toEqual(["equipe@example.com"]);
  });

  it("asks Rondyr to retry while the queue may still record the origin", async () => {
    const shared = await bilingualSite({
      en: ["team@example.com"],
      fr: ["equipe@example.com"],
    });
    // Rondyr stored the message, but its `202` never reached the site: the entry is pending.
    const entryId = crypto.randomUUID();
    await shared.store.createQueueEntry(entryId, newEntry("contact-fr", { nom: "Ada" }, now));
    expect(await shared.deliver(frenchMessage())).toEqual({ status: 503, code: "ORIGIN_PENDING" });
    expect(shared.sent).toEqual([]);
    expect(shared.collections.deliveries.rows.size).toBe(0);

    // The queue's next attempt replays the idempotency key and gets the same ID.
    const http = {
      fetch: async () =>
        Response.json({ "submission-id": submissionId, status: "received" }, { status: 202 }),
    };
    const later = now + 60_000;
    expect(await attempt({ ...shared.host, http }, options, token, entryId, () => later)).toBe(
      "sent",
    );
    expect(await shared.deliver(frenchMessage(), later)).toEqual({ status: 200, emailed: 1 });
    expect(shared.sent.map(({ to }) => to)).toEqual(["equipe@example.com"]);
  });

  it("stops waiting for the origin 15 minutes after Rondyr received the message", async () => {
    const shared = await bilingualSite({
      en: ["team@example.com"],
      fr: ["equipe@example.com"],
    });
    await shared.store.createQueueEntry(
      crypto.randomUUID(),
      newEntry("contact-fr", { nom: "Ada" }, now),
    );
    const receivedAt = new Date(now - 15 * 60_000).toISOString();
    expect(await shared.deliver(frenchMessage(receivedAt))).toEqual({ status: 200, emailed: 2 });
    expect(shared.sent.map(({ to }) => to)).toEqual(["team@example.com", "equipe@example.com"]);
  });
});

const autoReply = { subject: "We got your message", text: "Thanks, we'll answer soon." };

/** The auto-reply that the French form's visitor gets, at the first filled email field. */
const frenchAutoReply = { to: "ada@example.com", ...autoReply };

describe("receiveWebhook with an auto-reply held for the message", () => {
  it("sends it to the visitor after the team's emails, once even when Rondyr retries", async () => {
    const shared = await bilingualSite({ en: ["team@example.com"], fr: ["equipe@example.com"] });
    await shared.store.putOrigin(submissionId, {
      formSlug: "contact-fr",
      recordedAt: now,
      autoReply,
    });
    shared.failing.add("equipe@example.com");
    expect(await shared.deliver(frenchMessage())).toEqual({ status: 503, code: "EMAIL_FAILED" });
    expect(shared.sent).toEqual([frenchAutoReply]);
    shared.failing.clear();
    const later = now + 60_000;
    expect(await shared.deliver(frenchMessage(), later)).toEqual({ status: 200, emailed: 1 });
    expect(shared.sent.map(({ to }) => to)).toEqual(["ada@example.com", "equipe@example.com"]);
    expect(await shared.deliver(frenchMessage(), later)).toEqual({ status: 200, emailed: 0 });
    expect(shared.sent).toHaveLength(2);
  });

  it("sends it on Rondyr's retry when the mailer refused it, and nothing else twice", async () => {
    const shared = await bilingualSite({ en: ["team@example.com"], fr: ["equipe@example.com"] });
    await shared.store.putOrigin(submissionId, {
      formSlug: "contact-fr",
      recordedAt: now,
      autoReply,
    });
    shared.failing.add("ada@example.com");
    expect(await shared.deliver(frenchMessage())).toEqual({ status: 503, code: "EMAIL_FAILED" });
    // The log names the delivery, never the visitor's address.
    expect(shared.lines).toEqual([
      { level: "error", message: "Failed to send a held auto-reply", data: { deliveryId } },
    ]);
    shared.failing.clear();
    expect(await shared.deliver(frenchMessage(), now + 60_000)).toEqual({
      status: 200,
      emailed: 1,
    });
    expect(shared.sent.map(({ to }) => to)).toEqual(["equipe@example.com", "ada@example.com"]);
    expect(shared.sent[1]).toEqual(frenchAutoReply);
  });

  it("sends none without a plain address in the message, or when the origin is unknown", async () => {
    const shared = await bilingualSite({ en: ["team@example.com"], fr: ["equipe@example.com"] });
    await shared.store.putOrigin(submissionId, {
      formSlug: "contact-fr",
      recordedAt: now,
      autoReply,
    });
    const named = new TextDecoder()
      .decode(frenchMessage())
      .replace('"ada@example.com"', String.raw`"\"Ada\" <ada@example.com>"`);
    expect(await shared.deliver(encoder.encode(named))).toEqual({ status: 200, emailed: 1 });
    expect(shared.sent.map(({ to }) => to)).toEqual(["equipe@example.com"]);

    const unknown = await bilingualSite({ en: ["team@example.com"], fr: [] });
    expect(await unknown.deliver(frenchMessage())).toEqual({ status: 200, emailed: 1 });
    expect(unknown.sent.map(({ to }) => to)).toEqual(["team@example.com"]);
  });

  it("waits for the origin of a single form's message while a pending entry holds an auto-reply", async () => {
    const single = await bilingualSite({ en: [], fr: ["equipe@example.com"] });
    await single.store.putLink("contact-en", { rondyrFormId: null, recipients: [] });
    // A pending entry without an auto-reply doesn't hold up a single form's emails;
    // one with an auto-reply does, until its `202` records the origin.
    await single.store.createQueueEntry(
      crypto.randomUUID(),
      newEntry("contact-fr", { nom: "Grace" }, now),
    );
    const held = crypto.randomUUID();
    await single.store.createQueueEntry(
      held,
      newEntry("contact-fr", { nom: "Ada" }, now, autoReply),
    );
    expect(await single.deliver(frenchMessage())).toEqual({
      status: 503,
      code: "ORIGIN_PENDING",
    });
    expect(single.sent).toEqual([]);

    const http = {
      fetch: async () =>
        Response.json({ "submission-id": submissionId, status: "received" }, { status: 202 }),
    };
    const later = now + 60_000;
    expect(await attempt({ ...single.host, http }, options, token, held, () => later)).toBe("sent");
    expect(await single.deliver(frenchMessage(), later)).toEqual({ status: 200, emailed: 2 });
    expect(single.sent.map(({ to }) => to)).toEqual(["equipe@example.com", "ada@example.com"]);
  });
});

/** The French form's message in another delivery, as from a second Rondyr webhook to this site. */
function secondDelivery(receivedAt = sentAt) {
  return encoder.encode(
    new TextDecoder()
      .decode(frenchMessage(receivedAt))
      .replace(deliveryId, "9d3c1a2b-4e5f-4a6b-8c7d-0e1f2a3b4c5d"),
  );
}

/** A site whose French form's message has an auto-reply waiting in its origin. */
async function siteWithAutoReply() {
  const shared = await bilingualSite({ en: ["team@example.com"], fr: ["equipe@example.com"] });
  await shared.store.putOrigin(submissionId, {
    formSlug: "contact-fr",
    recordedAt: now,
    autoReply,
  });
  const autoReplies = () => shared.sent.filter(({ to }) => to === "ada@example.com");
  return { ...shared, autoReplies };
}

describe("receiveWebhook with several deliveries of one message", () => {
  it("sends the auto-reply once, and the recipients' email once per delivery", async () => {
    const shared = await siteWithAutoReply();
    expect(await shared.deliver(frenchMessage())).toEqual({ status: 200, emailed: 2 });
    // A replay of the queue's `202` keeps what the first delivery recorded.
    await shared.store.putOrigin(submissionId, {
      formSlug: "contact-fr",
      recordedAt: now + 1,
      autoReply,
    });
    expect(await shared.deliver(secondDelivery())).toEqual({ status: 200, emailed: 1 });
    expect(shared.sent.map(({ to }) => to)).toEqual([
      "equipe@example.com",
      "ada@example.com",
      "equipe@example.com",
    ]);
    expect(shared.autoReplies()).toHaveLength(1);
  });

  it("sends the auto-reply once when two deliveries arrive at the same time", async () => {
    const shared = await siteWithAutoReply();
    const slow = Promise.withResolvers<void>();
    const sending = Promise.withResolvers<void>();
    const held = {
      send: async (message: Sent) => {
        if (message.to === "ada@example.com") {
          sending.resolve();
          await slow.promise;
        }
        shared.sent.push(message);
      },
    };
    const body = frenchMessage();
    const first = receiveWebhook(
      { ...shared.host, email: held, input: body, request: { headers: await signed(body) } },
      [secret],
      now,
    );
    await sending.promise;
    const other = secondDelivery();
    const email = {
      send: async (message: Sent) => {
        shared.sent.push(message);
      },
    };
    const concurrent = await receiveWebhook(
      { ...shared.host, email, input: other, request: { headers: await signed(other) } },
      [secret],
      now,
    );
    expect(concurrent).toEqual({ status: 503, code: "AUTO_REPLY_IN_PROGRESS" });
    slow.resolve();
    expect(await first).toEqual({ status: 200, emailed: 2 });
    // Rondyr retries the second delivery a minute later: its recipients' email only.
    const later = now + 60_000;
    expect(await shared.deliver(other, later)).toEqual({ status: 200, emailed: 0 });
    expect(shared.autoReplies()).toHaveLength(1);
  });

  it("sends the auto-reply once after a failed send, whichever delivery retries first", async () => {
    const shared = await siteWithAutoReply();
    shared.failing.add("ada@example.com");
    expect(await shared.deliver(frenchMessage())).toEqual({ status: 503, code: "EMAIL_FAILED" });
    expect(shared.autoReplies()).toEqual([]);
    shared.failing.clear();
    const later = now + 60_000;
    expect(await shared.deliver(secondDelivery(), later)).toEqual({ status: 200, emailed: 2 });
    expect(await shared.deliver(frenchMessage(), later + 60_000)).toEqual({
      status: 200,
      emailed: 0,
    });
    expect(shared.autoReplies()).toEqual([frenchAutoReply]);
  });
});
