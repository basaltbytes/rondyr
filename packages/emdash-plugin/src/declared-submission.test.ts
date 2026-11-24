import { describe, expect, it } from "vitest";
import type { PublicPluginApiRouteHandler } from "emdash/plugin-utils";

import { pluginId } from "./constants.ts";
import { DeclaredForm } from "./core/declared-forms.ts";
import { attempt } from "./delivery.ts";
import {
  DeclaredPost,
  prepareDeclaredSubmission,
  receiveDeclaredPost,
} from "./declared-submission.ts";
import { enqueue } from "./enqueue.ts";
import { handleSubmission, submitSiteForm } from "./site-route.ts";
import { Store } from "./store.ts";
import { memoryHost } from "./testing/memory-storage.ts";
import { acceptedPayload, signedHeaders } from "./testing/webhook-request.ts";
import { receiveWebhook } from "./webhook.ts";

const origin = "https://site.example.com";
const rondyrUrl = "https://rondyr.example.com";
const now = Date.UTC(2026, 10, 22, 12);

const contact = DeclaredForm.parse({
  slug: "contact",
  name: "Contact",
  spamProtection: "turnstile",
  fields: [
    {
      name: "message",
      type: "textarea",
      required: true,
      labels: { en: "Message", fr: "Votre projet" },
    },
    { name: "email", type: "email", labels: { en: "Email", fr: "Courriel" } },
    { name: "hidden", type: "hidden", labels: { en: "Hidden" } },
  ],
});

describe("declared field rules", () => {
  it("takes all eight field types and drops unknown fields", () => {
    const form = DeclaredForm.parse({
      slug: "project",
      name: "Project",
      spamProtection: "honeypot",
      fields: [
        { name: "name", type: "text", maxLength: 3, labels: { en: "Name" } },
        { name: "email", type: "email", labels: { en: "Email" } },
        { name: "phone", type: "tel", labels: { en: "Phone" } },
        { name: "site", type: "url", labels: { en: "Website" } },
        { name: "message", type: "textarea", labels: { en: "Message" } },
        { name: "topic", type: "select", options: ["Quote", "Other"], labels: { en: "Topic" } },
        { name: "agree", type: "checkbox", required: true, labels: { en: "Agree" } },
        { name: "campaign", type: "hidden", labels: { en: "Campaign" } },
      ],
    });

    const result = prepareDeclaredSubmission(
      form,
      {
        formId: "project",
        fileFields: [],
        data: {
          name: " Ada ",
          email: "ada@example.com",
          phone: "+48 123 456 789",
          site: "https://example.com",
          message: "line one\nline two",
          topic: "Quote",
          agree: "on",
          campaign: "newsletter",
          other: "dropped",
        },
      },
      null,
    );

    expect(result.entry?.fields).toEqual({
      name: "Ada",
      email: "ada@example.com",
      phone: "+48 123 456 789",
      site: "https://example.com",
      message: "line one\nline two",
      topic: "Quote",
      agree: "true",
      campaign: "newsletter",
    });
  });

  it.each([
    { type: "text", value: "", message: "This field is required." },
    { type: "textarea", value: "123456", message: "Use at most 5 characters." },
    { type: "email", value: "ada", message: "Enter a valid email address." },
    {
      type: "email",
      value: "ada@example.com\r\nBcc: evil@example.com",
      message: "Enter a valid email address.",
    },
    { type: "email", value: "Ada <ada@example.com>", message: "Enter a valid email address." },
    { type: "tel", value: "abc", message: "Enter a valid phone number." },
    { type: "url", value: "file:///a", message: "Enter a valid HTTP or HTTPS URL." },
    { type: "select", value: "Other", message: "Choose one of the available options." },
    { type: "checkbox", value: false, message: "This field is required." },
    { type: "hidden", value: ["a", "b"], message: "Enter a valid value." },
  ])("reports the error on a $type field", ({ type, value, message }) => {
    const form = DeclaredForm.parse({
      slug: "contact",
      name: "Contact",
      spamProtection: "honeypot",
      fields: [
        {
          name: "value",
          type,
          required: true,
          labels: { en: "Value" },
          ...(type === "select" && { options: ["Quote"] }),
          ...(type === "textarea" && { maxLength: 5 }),
        },
      ],
    });

    const result = prepareDeclaredSubmission(
      form,
      { formId: "contact", fileFields: [], data: { value } },
      null,
    );

    expect(result).toEqual({
      answer: {
        success: false,
        code: "VALIDATION_ERROR",
        message: "Check the form fields.",
        errors: [{ field: "value", message }],
      },
    });
  });
});

/**
 * The site route's in-process hop with real validation and queue storage.
 * `queueFailures` is how many queue writes fail before one succeeds.
 */
function site(queueFailures = 0) {
  const { host, collections } = memoryHost();
  const store = new Store(host);
  let failuresLeft = queueFailures;
  const handlePublicPluginApiRoute: PublicPluginApiRouteHandler = async (
    plugin,
    method,
    path,
    request,
  ) => {
    expect({ plugin, method, path }).toEqual({
      plugin: pluginId,
      method: "POST",
      path: "/declared/submit",
    });
    const post = DeclaredPost.parse(await request.json());
    const form = post.formId === contact.slug ? contact : undefined;
    const answer = await receiveDeclaredPost(
      form,
      post,
      request.headers.get("cf-connecting-ip"),
      async (entry) => {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error("The queue is unavailable");
        }
        await enqueue(host, entry, now);
      },
    );
    return { success: true, data: answer };
  };
  const locals = {
    emdash: {
      handlePublicPluginApiRoute,
      getPublicPluginRouteMeta: () => ({ public: true }),
    },
  };
  const url = new URL("/api/form", origin);
  return {
    host,
    store,
    collections,
    post: (body: BodyInit, headers?: HeadersInit) =>
      handleSubmission(
        { request: new Request(url, { method: "POST", body, headers }), url, locals },
        null,
      ),
    submit: (data: Parameters<typeof submitSiteForm>[1], headers?: HeadersInit) =>
      submitSiteForm(
        { request: new Request(url, { method: "POST", headers }), url, locals },
        data,
        null,
      ),
  };
}

const jsonHeaders = { "content-type": "application/json" };

it("answers JSON validation errors in the forms script's field-error envelope", async () => {
  const form = site();

  const response = await form.post(
    JSON.stringify({ formId: "contact", data: { email: "invalid" } }),
    jsonHeaders,
  );

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    success: false,
    error: { code: "VALIDATION_ERROR", message: "Check the form fields." },
    data: {
      success: false,
      errors: [
        { field: "message", message: "This field is required." },
        { field: "email", message: "Enter a valid email address." },
      ],
    },
  });
  expect(await form.store.queueCount("pending")).toBe(0);
});

it("refuses a JSON attachment even when it is outside the declaration", async () => {
  const form = site();

  const response = await form.post(
    JSON.stringify({
      formId: "contact",
      data: { message: "Hello" },
      files: { attachment: { filename: "notes.txt", bytes: "QQ==", contentType: "text/plain" } },
    }),
    jsonHeaders,
  );

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    success: false,
    data: { errors: [{ field: "attachment", message: "File uploads are not supported." }] },
  });
  expect(await form.store.queueCount("pending")).toBe(0);
});

it("redirects a plain form to the same confirmation anchor after it queues the message", async () => {
  const form = site();

  const response = await form.post(
    new URLSearchParams({
      formId: "contact",
      message: "Bonjour",
      _return: "/bonjour",
      _block: "contact",
      _locale: "fr",
    }),
  );

  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/bonjour?form=contact&status=sent#contact-status");
  const [queued] = await form.store.queueEntries("pending", 1, null, "contact");
  expect(queued?.entry).toMatchObject({
    fields: { message: "Bonjour" },
    declared: { locale: "fr" },
  });
});

it("redirects a plain form with an empty file part to its error anchor without queuing", async () => {
  const form = site();
  const body = new FormData();
  body.set("formId", "contact");
  body.set("message", "Hello");
  body.set("_return", "/contact");
  body.set("attachment", new File([], "empty.txt"));

  const response = await form.post(body);

  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/contact?status=error");
  expect(await form.store.queueCount("pending")).toBe(0);
});

it("answers a filled honeypot as a success without queuing it", async () => {
  const form = site();

  const response = await form.post(
    JSON.stringify({ formId: "contact", data: { _hp: "filled" } }),
    jsonHeaders,
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    success: true,
    data: { success: true, message: "Submitted successfully." },
  });
  expect(await form.store.queueCount("pending")).toBe(0);
});

it("queues the message once when the first queue write fails", async () => {
  const form = site(1);

  const response = await form.post(
    JSON.stringify({ formId: "contact", data: { message: "Hello" } }),
    jsonHeaders,
  );

  expect(response.status).toBe(200);
  expect(await form.store.queueCount("pending")).toBe(1);
});

it("tells the visitor to try again when the queue refuses the message twice", async () => {
  const form = site(2);
  const post = { formId: "contact", data: { message: "Hello" } };

  const response = await form.post(JSON.stringify(post), jsonHeaders);

  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    success: false,
    error: {
      code: "QUEUE_UNAVAILABLE",
      message: "Your message could not be submitted. Please try again.",
    },
  });
  expect(await form.store.queueCount("pending")).toBe(0);

  const plain = await site(2).post(
    new URLSearchParams({ formId: "contact", message: "Hello", _return: "/contact" }),
  );
  expect(plain.status).toBe(303);
  expect(plain.headers.get("location")).toBe("/contact?status=error");
});

it("keeps the visitor token, IP and idempotency key from the first delivery attempt on a retry", async () => {
  const form = site();
  await form.store.putLink("contact", { rondyrFormId: "public-contact", recipients: [] });
  const response = await form.submit(
    {
      formId: "contact",
      locale: "fr-CA",
      data: { message: "Bonjour", "cf-turnstile-response": "widget-token" },
    },
    { "cf-connecting-ip": "192.0.2.10", "rondyr-visitor-ip": "192.0.2.99" },
  );
  expect(response.accepted).toBe(true);
  const [queued] = await form.store.queueEntries("pending", 1, null, "contact");
  if (queued === undefined) throw new Error("Expected a queued submission");
  const requests: Request[] = [];
  const http = {
    fetch: async (url: string, init?: RequestInit) => {
      requests.push(new Request(url, init));
      return requests.length === 1
        ? new Response(null, { status: 503 })
        : Response.json({ "submission-id": "stored-message" }, { status: 202 });
    },
  };

  expect(
    await attempt({ ...form.host, http }, { url: rondyrUrl }, "token", queued.id, () => now),
  ).toBe("retry");
  expect(
    await attempt(
      { ...form.host, http },
      { url: rondyrUrl },
      "token",
      queued.id,
      () => now + 60_000,
    ),
  ).toBe("sent");

  expect(requests).toHaveLength(2);
  const [first, second] = requests;
  expect(first?.headers.get("rondyr-turnstile")).toBe("verify");
  expect(first?.headers.get("rondyr-visitor-ip")).toBe("192.0.2.10");
  expect(first?.headers.get("idempotency-key")).toBe(queued.id);
  expect(Object.fromEntries(second?.headers ?? [])).toEqual(
    Object.fromEntries(first?.headers ?? []),
  );
  const body = { message: "Bonjour", "cf-turnstile-response": "widget-token" };
  expect(await first?.json()).toEqual(body);
  expect(await second?.json()).toEqual(body);
  expect(await form.store.queueEntry(queued.id)).toBeNull();
  expect(await form.store.origin("stored-message")).toEqual({
    formSlug: "contact",
    locale: "fr-ca",
    recordedAt: now + 60_000,
  });
});

it("uses the queued visitor locale in the acceptance email after another locale submits", async () => {
  const form = site();
  const fields = { message: "Bonjour", hidden: "internal" };
  await form.store.putLink("contact", {
    rondyrFormId: "public-contact",
    recipients: ["team@example.com"],
  });
  await form.submit({ formId: "contact", locale: "fr-CA", data: fields });
  const [first] = await form.store.queueEntries("pending", 1, null, "contact");
  if (first === undefined) throw new Error("Expected a queued submission");
  const http = {
    fetch: async () => Response.json({ "submission-id": "accepted-contact" }, { status: 202 }),
  };
  await attempt({ ...form.host, http }, { url: rondyrUrl }, "token", first.id, () => now);
  await form.submit({ formId: "contact", locale: "en", data: { message: "Hello" } });
  const input = acceptedPayload({
    deliveryId: "delivery-fr",
    submissionId: "accepted-contact",
    fields,
    receivedAt: new Date(now).toISOString(),
    formId: "public-contact",
  });
  const secret = "whsec_declared";
  const headers = await signedHeaders(input, secret, now);
  const sent: string[] = [];
  const email = {
    send: async ({ text }: { readonly text: string }) => {
      sent.push(text);
    },
  };

  await receiveWebhook({ ...form.host, email, input, request: { headers } }, [secret], now, [
    contact,
  ]);

  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("Votre projet: Bonjour");
  expect(sent[0]).not.toContain("internal");
});
