import { z } from "astro/zod";
import type { PublicPluginApiRouteHandler } from "emdash/plugin-utils";
import { describe, expect, it } from "vitest";

import { enqueueCredential } from "./core/hop.ts";
import { handleSubmission, submitToForms } from "./site-route.ts";

const site = "https://site.example.com";
const token = `rdr_${"S".repeat(43)}`;

type Answer = Awaited<ReturnType<PublicPluginApiRouteHandler>>;

const definition = {
  name: "Contact",
  slug: "contact",
  pages: [
    {
      fields: [
        { name: "name", label: "Your name", type: "text" },
        { name: "topics", label: "Topics", type: "checkbox-group" },
        { name: "cv", label: "CV", type: "file" },
      ],
    },
  ],
  settings: { spamProtection: "honeypot" },
};

const Json = z.record(z.string(), z.unknown());

interface Call {
  readonly route: string;
  readonly authorization: string | null;
  readonly body: z.infer<typeof Json>;
}

/** An EmDash runtime whose plugin routes answer from `answers`, by `plugin/route`. */
function emdash(answers: Readonly<Record<string, (call: Call) => Answer | Promise<Answer>>>) {
  const calls: Call[] = [];
  const handlePublicPluginApiRoute: PublicPluginApiRouteHandler = async (
    plugin,
    _method,
    path,
    request,
  ) => {
    const call = {
      route: `${plugin}${path}`,
      authorization: request.headers.get("authorization"),
      body: Json.parse(await request.json()),
    };
    calls.push(call);
    const answer = answers[call.route];
    if (answer === undefined) throw new Error(`Unexpected route ${call.route}`);
    return answer(call);
  };
  return { locals: { emdash: { handlePublicPluginApiRoute } }, calls };
}

const accepted = (): Answer => ({ success: true, data: { success: true, message: "Thanks" } });
const defined = (): Answer => ({ success: true, data: definition });
const queued = (): Answer => ({ success: true, data: { queued: true } });

/** What the contact block posts with JavaScript. */
interface PostedForm {
  readonly formId: string;
  readonly data: Readonly<Record<string, string | readonly string[]>>;
  readonly files?: Readonly<
    Record<string, { filename: string; contentType: string; bytes: string }>
  >;
}

function jsonPost(body: PostedForm, origin: string | null = site) {
  const headers = new Headers({ "content-type": "application/json" });
  if (origin !== null) headers.set("origin", origin);
  return new Request(`${site}/api/form`, { method: "POST", headers, body: JSON.stringify(body) });
}

const submit = (request: Request, locals: ReturnType<typeof emdash>["locals"]) =>
  handleSubmission({ request, url: new URL(request.url), locals }, token);

describe("the site route", () => {
  it("queues an accepted submission before it answers, without files", async () => {
    const { locals, calls } = emdash({
      "emdash-forms/submit": accepted,
      "emdash-forms/definition": defined,
      "rondyr/enqueue": queued,
    });
    const files = { cv: { filename: "cv.pdf", contentType: "application/pdf", bytes: "JVBERg==" } };
    const data = { name: "Ada", topics: ["Pottery", "Glazing"], _hp: "" };
    const response = await submit(jsonPost({ formId: "contact", data, files }), locals);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(accepted());
    expect(calls.map(({ route }) => route)).toEqual([
      "emdash-forms/submit",
      "emdash-forms/definition",
      "rondyr/enqueue",
    ]);
    // The forms plugin gets the files; Rondyr gets the form's fields, flattened.
    expect(calls[0]?.body).toEqual({ formId: "contact", data, files });
    expect(calls[2]).toEqual({
      route: "rondyr/enqueue",
      authorization: `Bearer ${token}`,
      body: {
        submissionId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        form: { slug: "contact", name: "Contact", fields: definition.pages[0]?.fields },
        fields: { name: "Ada", topics: "Pottery, Glazing" },
        // No forms plugin of this package answered: its emails went out at once.
        formsEmails: "sent",
        autoReply: null,
      },
    });
  });

  it("names a handoff on the call to the forms plugin, never the visitor's value, and closes it", async () => {
    const seen: (string | null)[] = [];
    const { locals } = emdash({
      "emdash-forms/submit": accepted,
      "emdash-forms/definition": defined,
      "rondyr/enqueue": queued,
    });
    const handle = locals.emdash.handlePublicPluginApiRoute;
    const spied: typeof handle = async (plugin, method, path, request) => {
      if (path === "/submit") seen.push(request.headers.get("x-rondyr-handoff"));
      return handle(plugin, method, path, request);
    };
    const request = jsonPost({ formId: "contact", data: { name: "Ada" } });
    request.headers.set("x-rondyr-handoff", "chosen-by-the-visitor");
    await handleSubmission(
      {
        request,
        url: new URL(request.url),
        locals: { emdash: { handlePublicPluginApiRoute: spied } },
      },
      token,
    );
    expect(seen).toEqual([expect.stringMatching(/^[0-9a-f-]{36}$/u)]);
    expect(globalThis.rondyrEmdashPluginHandoffs?.has(seen[0] ?? "")).toBe(false);
  });

  it("uses the isolate's key without a token", async () => {
    const { locals, calls } = emdash({
      "emdash-forms/submit": accepted,
      "emdash-forms/definition": defined,
      "rondyr/enqueue": queued,
    });
    const request = jsonPost({ formId: "contact", data: { name: "Ada" } });
    await handleSubmission({ request, url: new URL(request.url), locals }, null);
    expect(calls[2]?.authorization).toBe(`Bearer ${enqueueCredential(null)}`);
  });

  it("tries enqueue twice with the same ID, then records the failure; the visitor still gets the answer", async () => {
    let failures = 0;
    const { locals, calls } = emdash({
      "emdash-forms/submit": accepted,
      "emdash-forms/definition": defined,
      "rondyr/enqueue": () => {
        failures += 1;
        if (failures === 1) throw new Error("D1_ERROR: storage unavailable");
        return { success: false, error: { code: "STORAGE_INDEXES_NOT_READY", message: "" } };
      },
      "rondyr/enqueue/failed": () => ({ success: true, data: { recorded: true } }),
    });
    const response = await submit(jsonPost({ formId: "contact", data: { name: "Ada" } }), locals);
    expect(response.status).toBe(200);
    expect(calls.map(({ route }) => route)).toEqual([
      "emdash-forms/submit",
      "emdash-forms/definition",
      "rondyr/enqueue",
      "rondyr/enqueue",
      "rondyr/enqueue/failed",
    ]);
    expect(calls[2]?.body["submissionId"]).toBe(calls[3]?.body["submissionId"]);
    expect(calls[4]).toEqual({
      route: "rondyr/enqueue/failed",
      authorization: `Bearer ${token}`,
      body: { form: "contact", code: "STORAGE_INDEXES_NOT_READY" },
    });
  });

  it("records a failure when the form's definition can't be read, and answers anyway", async () => {
    const { locals, calls } = emdash({
      "emdash-forms/submit": accepted,
      "emdash-forms/definition": () => ({ success: true, data: { name: "Contact" } }),
      "rondyr/enqueue/failed": () => {
        throw new Error("Storage unavailable");
      },
    });
    const response = await submit(jsonPost({ formId: "contact", data: { name: "Ada" } }), locals);
    expect(response.status).toBe(200);
    expect(calls.at(-1)?.body).toEqual({ form: "contact", code: "DEFINITION_UNAVAILABLE" });
  });

  it("queues nothing for a refusal, a filled honeypot field or a cross-site post", async () => {
    const refused = emdash({
      "emdash-forms/submit": () => ({
        success: true,
        data: { success: false, errors: { name: "Required" } },
      }),
    });
    const invalid = await submit(jsonPost({ formId: "contact", data: {} }), refused.locals);
    expect(invalid.status).toBe(400);
    expect(refused.calls.map(({ route }) => route)).toEqual(["emdash-forms/submit"]);

    const trapped = emdash({
      "emdash-forms/submit": accepted,
      "emdash-forms/definition": defined,
    });
    const data = { name: "Bot", _hp: "filled" };
    const trap = await submit(jsonPost({ formId: "contact", data }), trapped.locals);
    expect(trap.status).toBe(200);
    expect(trapped.calls.map(({ route }) => route)).toEqual([
      "emdash-forms/submit",
      "emdash-forms/definition",
    ]);

    const crossSite = emdash({});
    const elsewhere = jsonPost({ formId: "contact", data }, "https://elsewhere.example.com");
    expect((await submit(elsewhere, crossSite.locals)).status).toBe(403);
    expect(crossSite.calls).toEqual([]);
  });

  it("answers as the forms plugin's own route would, and keeps the answer out of caches", async () => {
    // EmDash's in-process envelope carries the route's status, which its own route doesn't send.
    const { locals } = emdash({
      "emdash-forms/submit": () => ({ ...accepted(), status: 200 }),
      "emdash-forms/definition": defined,
      "rondyr/enqueue": queued,
    });
    const response = await submit(jsonPost({ formId: "contact", data: { name: "Ada" } }), locals);
    expect(await response.json()).toEqual(accepted());
    expect(response.headers.get("cache-control")).toBe("private, no-store");

    const turnstile = emdash({
      "emdash-forms/submit": () => ({
        success: false,
        status: 403,
        error: { code: "FORBIDDEN", message: "Spam verification required" },
      }),
    });
    const refused = await submit(jsonPost({ formId: "contact", data: {} }), turnstile.locals);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      success: false,
      error: { code: "FORBIDDEN", message: "Spam verification required" },
    });
    expect(turnstile.calls.map(({ route }) => route)).toEqual(["emdash-forms/submit"]);

    const internal = emdash({
      "emdash-forms/submit": () => ({
        success: false,
        status: 500,
        error: { code: "INTERNAL_ERROR", message: "Turnstile is not configured" },
      }),
    });
    const failed = await submit(jsonPost({ formId: "contact", data: {} }), internal.locals);
    expect(await failed.json()).toEqual({
      success: false,
      error: { code: "INTERNAL_ERROR", message: "Plugin route error" },
    });

    const form = new FormData();
    form.set("formId", "contact");
    const post = new Request(`${site}/api/form`, {
      method: "POST",
      headers: { origin: site },
      body: form,
    });
    const redirect = await submit(post, emdash({ "emdash-forms/submit": accepted }).locals);
    expect(redirect.headers.get("cache-control")).toBe("private, no-store");
  });

  it("takes a post without JavaScript, with its files and repeated names, and redirects", async () => {
    const { locals, calls } = emdash({
      "emdash-forms/submit": accepted,
      "emdash-forms/definition": defined,
      "rondyr/enqueue": queued,
    });
    const form = new FormData();
    form.set("formId", "contact");
    form.set("_return", "/contact");
    form.set("_block", "contact-form");
    form.set("name", "Ada");
    form.append("topics", "Pottery");
    form.append("topics", "Glazing");
    form.set("cv", new File(["%PDF"], "cv.pdf", { type: "application/pdf" }));
    const request = new Request(`${site}/api/form`, {
      method: "POST",
      headers: { origin: site },
      body: form,
    });
    const response = await submit(request, locals);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "/contact?form=contact-form&status=sent#contact-form-status",
    );
    expect(calls[0]?.body).toEqual({
      formId: "contact",
      data: { name: "Ada", topics: ["Pottery", "Glazing"] },
      files: { cv: { filename: "cv.pdf", contentType: "application/pdf", bytes: btoa("%PDF") } },
    });
    expect(calls[2]?.body["fields"]).toEqual({ name: "Ada", topics: "Pottery, Glazing" });
  });
});

/** A post without JavaScript that the page has already read, as Astro's `formData()` leaves it. */
async function readPost(origin: string | null = site) {
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
    "cf-connecting-ip": "203.0.113.7",
  });
  if (origin !== null) headers.set("origin", origin);
  const request = new Request(`${site}/form`, {
    method: "POST",
    headers,
    body: "formId=contact&name=Ada",
  });
  await request.formData();
  return request;
}

describe("submitToForms, for a site's own route or page", () => {
  it("returns the forms plugin's answer once the submission is queued, without reading the body", async () => {
    const seen: Request[] = [];
    const { locals, calls } = emdash({
      "emdash-forms/submit": accepted,
      "emdash-forms/definition": () => ({
        success: true,
        data: {
          ...definition,
          pages: [
            { fields: [{ name: "email", label: "Email", type: "email", required: true }] },
            ...definition.pages,
          ],
        },
      }),
      "rondyr/enqueue": queued,
    });
    const handle = locals.emdash.handlePublicPluginApiRoute;
    const spied: typeof handle = async (plugin, method, path, request) => {
      seen.push(request);
      return handle(plugin, method, path, request);
    };
    const request = await readPost();
    const data = { email: "ada@example.com", name: "Ada" };
    const result = await submitToForms(
      {
        request,
        url: new URL(request.url),
        locals: { emdash: { handlePublicPluginApiRoute: spied } },
      },
      { formId: "contact", data },
      token,
    );
    expect(result).toEqual({ accepted: true, answer: accepted() });
    expect(calls.map(({ route }) => route)).toEqual([
      "emdash-forms/submit",
      "emdash-forms/definition",
      "rondyr/enqueue",
    ]);
    expect(calls[0]?.body).toEqual({ formId: "contact", data });
    // The forms plugin still sees the visitor's address.
    expect(seen[0]?.headers.get("cf-connecting-ip")).toBe("203.0.113.7");
    expect(calls[2]?.body["form"]).toEqual({
      slug: "contact",
      name: "Contact",
      fields: [
        { name: "email", label: "Email", type: "email", required: true },
        ...definition.pages.flatMap(({ fields }) => fields),
      ],
    });
    expect(calls[2]?.body["fields"]).toEqual(data);
  });

  it("returns a refusal without queuing anything", async () => {
    const refusal: Answer = {
      success: true,
      data: { success: false, errors: { name: "Required" } },
    };
    const { locals, calls } = emdash({ "emdash-forms/submit": () => refusal });
    const request = await readPost();
    const result = await submitToForms(
      { request, url: new URL(request.url), locals },
      { formId: "contact", data: {} },
      token,
    );
    expect(result).toEqual({ accepted: false, answer: refusal });
    expect(calls.map(({ route }) => route)).toEqual(["emdash-forms/submit"]);
  });

  it("refuses a post from another site without calling the forms plugin", async () => {
    const { locals, calls } = emdash({});
    const request = await readPost("https://elsewhere.example.com");
    const result = await submitToForms(
      { request, url: new URL(request.url), locals },
      { formId: "contact", data: { name: "Ada" } },
      token,
    );
    expect(result.accepted).toBe(false);
    expect(result.answer).toMatchObject({ success: false, error: { code: "CROSS_SITE" } });
    expect(calls).toEqual([]);
  });
});
