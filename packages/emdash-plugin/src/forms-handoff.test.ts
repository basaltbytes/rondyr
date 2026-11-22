import { createPlugin as createFormsPlugin } from "@emdash-cms/plugin-forms";
import type { EmailMessage } from "emdash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QueueEntry } from "./core/queue.ts";
import { attempt } from "./delivery.ts";
import { createPlugin } from "./forms-plugin.ts";
import { createPlugin as createPluginWithSubmissions } from "./forms-with-submissions.ts";
import { submitToForms } from "./site-route.ts";
import { Store } from "./store.ts";
import { formsSite, siteUrl, type FormSettingsInput } from "./testing/forms-site.ts";
import { acceptedPayload, signedHeaders } from "./testing/webhook-request.ts";
import { receiveWebhook } from "./webhook.ts";

// The real forms plugin, wrapped as `formsWithoutSubmissions()` loads it, behind
// the site route, with the Rondyr plugin's `enqueue` over in-memory storage.

const start = Date.UTC(2026, 10, 22, 9);
const token = `rdr_${"T".repeat(43)}`;
const secret = "whsec_site-secret";

const fields = [
  { name: "name", label: "Your name", type: "text", required: true },
  { name: "email", label: "Email", type: "email", required: true },
  { name: "message", label: "Message", type: "textarea", required: false },
] as const;

const ownEmails: FormSettingsInput = {
  notifyEmails: ["team@example.com"],
  autoresponder: { subject: "We got your message", body: "Thanks, we'll answer soon." },
};

const visitor = { name: "Ada", email: "ada@example.com", message: "Is there room?" };

beforeEach(() => {
  // The forms plugin stamps each email with the time: a fixed clock makes them comparable.
  vi.useFakeTimers({ now: start, toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

async function site(
  linked: boolean,
  settings: FormSettingsInput = ownEmails,
  plugin = createPlugin,
) {
  const created = formsSite(plugin, () => start);
  const formId = await created.createForm("contact", fields, settings);
  const store = new Store(created.rondyr.host);
  if (linked) {
    await store.putLink("contact", {
      rondyrFormId: "rondyr-contact",
      recipients: ["inbox@example.com"],
    });
  }
  return { ...created, formId, store };
}

type Site = Awaited<ReturnType<typeof site>>;

/** Post through the site route, as the contact block does. */
function post(target: Site, data: Readonly<Record<string, string>> = visitor) {
  const request = new Request(`${siteUrl}/contact`, {
    method: "POST",
    headers: { origin: siteUrl },
  });
  return submitToForms(
    { request, url: new URL(request.url), locals: target.locals },
    { formId: "contact", data },
    token,
  );
}

async function queueEntries(target: Site) {
  return [...target.rondyr.collections.queue.rows.entries()].map(([id, { data }]) => ({
    id,
    entry: QueueEntry.parse(data),
  }));
}

/** What the forms plugin alone sends for the same post. */
async function formsPluginAlone(settings: FormSettingsInput = ownEmails) {
  const alone = await site(false, settings, createFormsPlugin);
  await alone.postToFormsPlugin(alone.formId, visitor);
  return alone.sent;
}

describe("a form linked to a Rondyr form", () => {
  it("sends none of the forms plugin's emails and queues the submission with its auto-reply", async () => {
    const linked = await site(true);
    const result = await post(linked);
    expect(result.accepted).toBe(true);
    expect(linked.sent).toEqual([]);
    // The forms plugin still validated and stored its copy.
    expect(linked.storage.submissions.rows.size).toBe(1);
    const [queued] = await queueEntries(linked);
    expect(queued?.entry).toMatchObject({
      formSlug: "contact",
      fields: visitor,
      autoReply: { subject: "We got your message", text: "Thanks, we'll answer soon." },
    });
    // The auto-reply waiting in the queue is the one the forms plugin would have sent.
    const autoReply = (await formsPluginAlone()).find(({ to }) => to === visitor.email);
    expect(autoReply).toEqual({
      to: visitor.email,
      subject: queued?.entry.autoReply?.subject,
      text: queued?.entry.autoReply?.text,
    });
  });

  it("emails Rondyr's recipients and sends the auto-reply once Rondyr accepts the message, once", async () => {
    const linked = await site(true);
    await post(linked);
    const [queued] = await queueEntries(linked);
    if (queued === undefined) throw new Error("Nothing was queued");
    const http = {
      fetch: async () =>
        Response.json({ "submission-id": "rondyr-1", status: "received" }, { status: 202 }),
    };
    expect(
      await attempt(
        { ...linked.rondyr.host, http },
        { url: "https://rondyr.example.com" },
        token,
        queued.id,
        () => start,
      ),
    ).toBe("sent");

    const delivered: EmailMessage[] = [];
    let mailerDown = true;
    const email = {
      send: async (message: EmailMessage) => {
        // The first delivery fails for the team's address only.
        if (mailerDown && message.to === "inbox@example.com") throw new Error("Mailer down");
        delivered.push(message);
      },
    };
    const body = acceptedPayload({
      deliveryId: "1b4e28ba-2fa1-4d2b-883f-0016d3cca427",
      submissionId: "rondyr-1",
      receivedAt: new Date(start).toISOString(),
      fields: queued.entry.fields,
      formId: "rondyr-contact",
    });
    const deliver = async () =>
      receiveWebhook(
        {
          ...linked.rondyr.host,
          email,
          input: body,
          request: { headers: await signedHeaders(body, secret, start) },
        },
        [secret],
        start,
      );

    expect(await deliver()).toEqual({ status: 503, code: "EMAIL_FAILED" });
    expect(delivered).toEqual([
      { to: visitor.email, subject: "We got your message", text: "Thanks, we'll answer soon." },
    ]);
    // Rondyr retries the delivery: the team gets its email, the visitor no second auto-reply.
    mailerDown = false;
    expect(await deliver()).toEqual({ status: 200, emailed: 1 });
    expect(delivered.map(({ to }) => to)).toEqual([visitor.email, "inbox@example.com"]);
    expect(await deliver()).toEqual({ status: 200, emailed: 0 });
    expect(delivered).toHaveLength(2);
    // The forms plugin itself sent nothing at any point.
    expect(linked.sent).toEqual([]);
  });

  it("leaves the submissions that Rondyr has out of the daily digest", async () => {
    const linked = await site(true, { ...ownEmails, digestEnabled: true });
    const [digest] = [...linked.scheduled.keys()];
    if (digest === undefined) throw new Error("The forms plugin scheduled no digest");
    await post(linked);
    await post(linked, { ...visitor, name: "Grace" });
    await linked.runCron(digest);
    expect(linked.sent).toEqual([]);

    // A post that bypasses Rondyr still gets its auto-reply at once, and the digest.
    await linked.postToFormsPlugin(linked.formId, { ...visitor, name: "Linus" });
    expect(linked.sent.map(({ to }) => to)).toEqual([visitor.email]);
    await linked.runCron(digest);
    expect(linked.sent).toHaveLength(2);
    expect(linked.sent[1]).toMatchObject({
      to: "team@example.com",
      subject: "Daily digest: Form contact (1 new)",
    });
    expect(linked.sent[1]?.text).toContain("Linus");
    expect(linked.sent[1]?.text).not.toContain("Grace");
  });

  it("sends the held emails when the submission can't be queued", async () => {
    const linked = await site(true);
    linked.state.queueDown = true;
    const result = await post(linked);
    expect(result.accepted).toBe(true);
    expect(linked.state.unqueued).toBe(1);
    expect(linked.sent).toEqual(await formsPluginAlone());
  });
});

describe("a form without a Rondyr form", () => {
  it("sends the forms plugin's emails as the forms plugin alone does, and queues no auto-reply", async () => {
    const unlinked = await site(false);
    expect((await post(unlinked)).accepted).toBe(true);
    expect(unlinked.sent).toEqual(await formsPluginAlone());
    expect(unlinked.sent.map(({ to }) => to)).toEqual(["team@example.com", visitor.email]);
    const [queued] = await queueEntries(unlinked);
    expect(queued?.entry.autoReply).toBeUndefined();
  });

  it("keeps its submissions in the daily digest", async () => {
    const unlinked = await site(false, { ...ownEmails, digestEnabled: true });
    const [digest] = [...unlinked.scheduled.keys()];
    if (digest === undefined) throw new Error("The forms plugin scheduled no digest");
    await post(unlinked);
    await unlinked.runCron(digest);
    expect(unlinked.sent.map(({ to, subject }) => ({ to, subject }))).toEqual([
      { to: visitor.email, subject: "We got your message" },
      { to: "team@example.com", subject: "Daily digest: Form contact (1 new)" },
    ]);
  });
});

describe("a submission posted straight to the forms plugin", () => {
  it("keeps every email of a linked form, even with a guessed handoff header, and is counted", async () => {
    const linked = await site(true);
    const answer = await linked.postToFormsPlugin(linked.formId, visitor);
    expect(answer.success).toBe(true);
    expect(linked.sent).toEqual(await formsPluginAlone());
    expect(await queueEntries(linked)).toEqual([]);

    const request = new Request(`${siteUrl}/_emdash/api/plugins/emdash-forms/rondyr/bypassed`);
    const counted = await linked.route("rondyr/bypassed", {}, request);
    expect(counted).toEqual({
      success: true,
      data: { items: [{ formId: linked.formId, count: 1, firstAt: start, lastAt: start }] },
    });
    await linked.route("rondyr/bypassed/clear", { formId: linked.formId }, request);
    expect(await linked.route("rondyr/bypassed", {}, request)).toEqual({
      success: true,
      data: { items: [] },
    });
  });

  it("isn't counted when it comes through the site route", async () => {
    const linked = await site(true);
    await post(linked);
    const request = new Request(`${siteUrl}/_emdash/api/plugins/emdash-forms/rondyr/bypassed`);
    expect(await linked.route("rondyr/bypassed", {}, request)).toEqual({
      success: true,
      data: { items: [] },
    });
  });
});

describe("the forms plugins this package doesn't wrap", () => {
  it("report that the forms plugin sent its own emails, so the settings page can say so", async () => {
    const plain = await site(true, ownEmails, createFormsPlugin);
    await post(plain);
    // `formsPlugin()` sends at once; the Rondyr plugin can't hold them, and records it.
    expect(plain.sent).toHaveLength(2);
    expect(await plain.store.formsEmailsSent()).toEqual(["contact"]);
    expect((await queueEntries(plain))[0]?.entry.autoReply).toBeUndefined();

    const wrapped = await site(true);
    await post(wrapped);
    expect(await wrapped.store.formsEmailsSent()).toEqual([]);
  });

  it("holds the emails with formsWithRondyr() too, which keeps the Submissions page", async () => {
    const linked = await site(true, ownEmails, createPluginWithSubmissions);
    await post(linked);
    expect(linked.sent).toEqual([]);
    expect(linked.plugin.admin.pages?.map(({ path }) => path)).toEqual(["/", "/submissions"]);
  });
});
