import { z } from "astro/zod";
import {
  getPublicPluginApiRouteHandler,
  type PublicPluginRuntimeLocals,
} from "emdash/plugin-utils";

import { formsPluginId, pluginId } from "./constants.ts";
import { flattenFields, formLayout, SubmittedData, type FormLayout } from "./core/fields.ts";
import { enqueueCredential } from "./core/hop.ts";
import { DeclaredAnswer, DeclaredPost, RenderableForm } from "./declared-submission.ts";
import { handoffHeader, openHandoff, type Handoff } from "./handoff.ts";

/** The forms plugin's honeypot field, which the contact block names `_hp`. */
const honeypotField = "_hp";
const sameSitePath = /^\/(?![/\\])/u;
const blockKey = /^[\w-]{1,64}$/u;
const errorCode = /^[\w-]{1,64}$/u;
const declaredMaxBodyBytes = 32 * 1024;
const formsMaxBodyBytes = 10 * 1024 * 1024;
const base64ChunkSize = 0x8000;
const rateLimitRetryAfter = "60";

/** A file as the forms plugin's `submit` takes it: base64 bytes. Rondyr never gets it. */
const SubmittedFile = z.object({
  filename: z.string(),
  contentType: z.string(),
  bytes: z.string(),
});
type SubmittedFile = z.infer<typeof SubmittedFile>;

const JsonBody = z.object({
  formId: z.string().min(1).max(200),
  data: SubmittedData,
  files: z.record(z.string(), SubmittedFile).optional(),
  locale: z.string().optional(),
});

/** The parts of the forms plugin's public definition that the notification needs. */
const Definition = z.object({
  name: z.string(),
  slug: z.string(),
  pages: z.array(
    z.object({
      fields: z.array(
        z.object({
          name: z.string(),
          label: z.string(),
          type: z.string(),
          required: z.boolean().optional(),
        }),
      ),
    }),
  ),
  settings: z.object({ spamProtection: z.string().optional() }).optional(),
});
type Definition = z.infer<typeof Definition>;

const Envelope = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.object({ code: z.string() }).optional(),
});
const Accepted = z.object({ success: z.literal(true) });

type Handle = NonNullable<ReturnType<typeof getPublicPluginApiRouteHandler>>;

/** What a plugin route answers in-process: `{ success, data }` or `{ success: false, error }`. */
type PluginAnswer = Awaited<ReturnType<Handle>>;

/**
 * The forms plugin's answer as EmDash's own route for it sends it: the data
 * when the route succeeded, otherwise the error's code and message, with the
 * message of an internal error hidden.
 */
export type FormsAnswer =
  | { readonly success: true; readonly data: unknown }
  | {
      readonly success: false;
      readonly error: { readonly code: string; readonly message: string };
      readonly data?: {
        readonly success: false;
        readonly errors: readonly { readonly field: string; readonly message: string }[];
      };
    };

function formsAnswer(answer: PluginAnswer): FormsAnswer {
  if (answer.success) return { success: true, data: answer.data };
  const code = answer.error?.code ?? "PLUGIN_ERROR";
  const message =
    code === "INTERNAL_ERROR"
      ? "Plugin route error"
      : (answer.error?.message ?? "Plugin route error");
  return { success: false, error: { code, message } };
}

/** The forms plugin's route never lets a cache keep its answer; neither does this one. */
const noStore = { "cache-control": "private, no-store" };

/** A submission as the forms plugin's `submit` takes it. `formId` is the form's ID or slug. */
export interface FormSubmission {
  readonly formId: string;
  readonly data: SubmittedData;
  readonly locale?: string;
  readonly files?: Readonly<Record<string, SubmittedFile>>;
}

/**
 * What became of a submission. `accepted` is true when the forms plugin
 * accepted it, a filled honeypot field included. `answer` is the forms
 * plugin's answer, as its own route would send it: `{ success: true, data:
 * { success: true, message, redirect } }` when it accepted.
 */
export interface SubmitResult {
  readonly accepted: boolean;
  readonly answer: FormsAnswer;
}

interface Submission extends FormSubmission {
  readonly files: Readonly<Record<string, SubmittedFile>>;
  readonly back: string | null;
  readonly block: string | null;
}

function base64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += base64ChunkSize) {
    const chunk = bytes.subarray(offset, offset + base64ChunkSize);
    parts.push(String.fromCharCode(...chunk));
  }
  return btoa(parts.join(""));
}

type BodyRead =
  | { readonly ok: true; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly ok: false; readonly reason: "too-large" | "read-error" };

async function readBoundedBody(request: Request, maxBytes: number): Promise<BodyRead> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength.trim());
    if (Number.isFinite(length) && length > maxBytes) {
      await request.body?.cancel().catch(() => {});
      return { ok: false, reason: "too-large" };
    }
  }
  if (request.body === null) return { ok: true, bytes: new Uint8Array(0) };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "too-large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "read-error" };
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

type SubmissionRead =
  | { readonly kind: "ok"; readonly submission: Submission }
  | { readonly kind: "too-large" }
  | { readonly kind: "invalid" };

async function readSubmission(request: Request, declared: boolean): Promise<SubmissionRead> {
  const maxBytes = declared ? declaredMaxBodyBytes : formsMaxBodyBytes;
  const body = await readBoundedBody(request, maxBytes);
  if (!body.ok) {
    return body.reason === "too-large" ? { kind: "too-large" } : { kind: "invalid" };
  }
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  const buffered = new Request(request.url, { method: "POST", headers, body: body.bytes });
  const type = buffered.headers.get("content-type") ?? "";
  if (type.toLowerCase().startsWith("application/json")) {
    const parsed = JsonBody.safeParse(await buffered.json().catch(() => null));
    if (!parsed.success) return { kind: "invalid" };
    const { formId, data, files, locale } = parsed.data;
    return {
      kind: "ok",
      submission: { formId, data, files: files ?? {}, locale, back: null, block: null },
    };
  }
  const form = await buffered.formData().catch(() => null);
  if (form === null) return { kind: "invalid" };
  const data = new Map<string, string | string[]>();
  const files = new Map<string, SubmittedFile>();
  let formId = "";
  let back: string | null = null;
  let block: string | null = null;
  for (const [key, value] of form.entries()) {
    if (value instanceof File) {
      // An empty file input still posts a nameless, empty file.
      if (declared || value.size > 0) {
        files.set(key, {
          filename: value.name,
          contentType: value.type === "" ? "application/octet-stream" : value.type,
          bytes: declared ? "" : base64(new Uint8Array(await value.arrayBuffer())),
        });
      }
      continue;
    }
    if (key === "formId") formId = value;
    else if (key === "_return") back = value;
    else if (key === "_block") block = value;
    else {
      // A repeated name, such as a checkbox group, becomes a list, as with JavaScript.
      const previous = data.get(key);
      data.set(
        key,
        previous === undefined
          ? value
          : Array.isArray(previous)
            ? [...previous, value]
            : [previous, value],
      );
    }
  }
  return formId === ""
    ? { kind: "invalid" }
    : {
        kind: "ok",
        submission: {
          formId,
          data: Object.fromEntries(data),
          files: Object.fromEntries(files),
          back,
          block,
        },
      };
}

function pluginRequest(url: URL, path: string, body: string, headers: Headers): Request {
  return new Request(new URL(`/_emdash/api/plugins/${path}`, url), {
    method: "POST",
    headers,
    body,
  });
}

/** What a plugin route answered, or why it didn't. Never throws. */
async function callPlugin(
  handle: Handle,
  url: URL,
  target: { readonly plugin: string; readonly route: string },
  body: string,
  headers: Headers,
): Promise<{ readonly data: unknown } | { readonly failure: string }> {
  try {
    const request = pluginRequest(url, `${target.plugin}/${target.route}`, body, headers);
    const envelope = Envelope.safeParse(
      await handle(target.plugin, "POST", `/${target.route}`, request),
    );
    if (!envelope.success) return { failure: "UNEXPECTED_ANSWER" };
    if (envelope.data.success) return { data: envelope.data.data };
    const code = envelope.data.error?.code ?? "UNKNOWN";
    return { failure: errorCode.test(code) ? code : "UNKNOWN" };
  } catch {
    return { failure: "EXCEPTION" };
  }
}

async function definitionOf(handle: Handle, url: URL, formId: string) {
  const headers = new Headers({ "content-type": "application/json" });
  const body = JSON.stringify({ id: formId });
  const target = { plugin: formsPluginId, route: "definition" };
  // Read twice: the forms plugin has just read this form, so a failure is passing.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await callPlugin(handle, url, target, body, headers);
    if ("data" in result) {
      const definition = Definition.safeParse(result.data);
      if (definition.success) return definition.data;
    }
  }
  return null;
}

/** A post whose `Origin` is another site. The forms plugin's own route refuses it; called in-process it can't. */
function crossSite(request: Request, url: URL): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin !== url.origin;
}

function layoutOf(definition: Definition): FormLayout {
  return formLayout(
    definition.slug,
    definition.name,
    definition.pages.flatMap(({ fields }) => fields),
  );
}

/** The Rondyr plugin's answer to `enqueue`: whether the form has a Rondyr form. */
const Queued = z.object({ linked: z.boolean() });

/**
 * Put an accepted submission in the Rondyr plugin's queue, in this Worker,
 * before the visitor gets the answer, with what the forms plugin held. `enqueue`
 * is idempotent, so a failed call is made once more. When both fail, the
 * plugin records it: the admin pages then say how many submissions of the form
 * were not queued, and its log says why. The forms plugin keeps its copy, and
 * the visitor gets its answer anyway.
 *
 * Returns true when the submission is queued for a form linked to a Rondyr
 * form, whose held emails Rondyr replaces.
 */
async function forward(
  handle: Handle,
  url: URL,
  submission: FormSubmission,
  definition: Definition | null,
  token: string | null,
  handoff: Handoff,
): Promise<boolean> {
  const headers = new Headers({
    "content-type": "application/json",
    authorization: `Bearer ${enqueueCredential(token)}`,
  });
  const target = { plugin: pluginId, route: "enqueue" };
  let failure = "DEFINITION_UNAVAILABLE";
  if (definition !== null) {
    const layout = layoutOf(definition);
    const body = JSON.stringify({
      submissionId: crypto.randomUUID(),
      form: layout,
      fields: flattenFields(layout, submission.data),
      formsEmails: handoff.held ? "held" : "sent",
      autoReply: handoff.autoReply,
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await callPlugin(handle, url, target, body, headers);
      if ("data" in result) {
        const queued = Queued.safeParse(result.data);
        return queued.success && queued.data.linked;
      }
      failure = result.failure;
    }
  }
  const form = definition === null ? submission.formId : definition.slug;
  const report = JSON.stringify({ form: form.slice(0, 200), code: failure });
  await callPlugin(handle, url, { plugin: pluginId, route: "enqueue/failed" }, report, headers);
  return false;
}

/** What the site route reads from Astro's context. */
export interface SiteRequest {
  readonly request: Request;
  readonly url: URL;
  readonly locals: PublicPluginRuntimeLocals & {
    readonly emdash?: {
      readonly getPublicPluginRouteMeta?: (plugin: string, path: string) => object | null;
    };
  };
}

const invalid: FormsAnswer = {
  success: false,
  error: { code: "INVALID_REQUEST", message: "Invalid form" },
};

const payloadTooLarge: FormsAnswer = {
  success: false,
  error: { code: "PAYLOAD_TOO_LARGE", message: "Submission is too large." },
};

/**
 * Submit to the forms plugin in this Worker and, once it accepts, put the
 * submission in the Rondyr plugin's queue before returning, without its files.
 * `site.request` is the visitor's request: the forms plugin reads the
 * visitor's IP and country from its headers, and its body is not read.
 * `token` is `RONDYR_API_TOKEN`, or null.
 *
 * The call to `submit` names a handoff (see `handoff.ts`): the forms plugin of
 * this package holds the emails it would send at once. Once the submission is
 * queued for a form linked to a Rondyr form, they are dropped; in any other
 * case, a failure included, they go out before this returns.
 *
 * A post from another site is refused without calling the forms plugin, as
 * the forms plugin's own route would refuse it.
 */
export async function submitToForms(
  site: SiteRequest,
  submission: FormSubmission,
  token: string | null,
): Promise<SubmitResult> {
  const { request, url, locals } = site;
  if (crossSite(request, url)) {
    return {
      accepted: false,
      answer: {
        success: false,
        error: { code: "CROSS_SITE", message: "Cross-site form submission" },
      },
    };
  }
  const handle = getPublicPluginApiRouteHandler(locals);
  if (handle === undefined) return { accepted: false, answer: invalid };

  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  const ticket = openHandoff();
  // Set, not appended: a value the visitor sent never names a handoff.
  headers.set(handoffHeader, ticket.id);
  const body: z.input<typeof JsonBody> = { formId: submission.formId, data: submission.data };
  const files = submission.files ?? {};
  if (Object.keys(files).length > 0) body.files = files;
  let handled = false;
  try {
    // Built from the incoming request, so the forms plugin still sees the visitor's IP and country.
    const answer = await handle(
      formsPluginId,
      "POST",
      "/submit",
      new Request(request, { method: "POST", headers, body: JSON.stringify(body) }),
    );
    const envelope = Envelope.safeParse(answer);
    const accepted =
      envelope.success && envelope.data.success && Accepted.safeParse(envelope.data.data).success;
    if (accepted) {
      const definition = await definitionOf(handle, url, submission.formId);
      // The forms plugin answers a filled honeypot like a success and stores nothing; so does Rondyr.
      const trap =
        definition?.settings?.spamProtection === "honeypot" &&
        Boolean(submission.data[honeypotField]);
      if (!trap) {
        handled = await forward(handle, url, submission, definition, token, ticket.handoff);
      }
    }
    return { accepted, answer: formsAnswer(answer) };
  } finally {
    // The forms plugin's held emails go out unless Rondyr has the submission of a linked form.
    try {
      await ticket.handoff.settle(handled);
    } finally {
      ticket.close();
    }
  }
}

function hasDeclaredForms(locals: SiteRequest["locals"]): boolean {
  return locals.emdash?.getPublicPluginRouteMeta?.(pluginId, "/declared/submit") != null;
}

const queueUnavailable: FormsAnswer = {
  success: false,
  error: {
    code: "QUEUE_UNAVAILABLE",
    message: "Your message could not be submitted. Please try again.",
  },
};

async function submitToDeclared(
  site: SiteRequest,
  submission: FormSubmission,
  token: string | null,
): Promise<SubmitResult> {
  if (crossSite(site.request, site.url)) {
    return {
      accepted: false,
      answer: {
        success: false,
        error: { code: "CROSS_SITE", message: "Cross-site form submission" },
      },
    };
  }
  const handle = getPublicPluginApiRouteHandler(site.locals);
  if (handle === undefined) return { accepted: false, answer: queueUnavailable };
  const headers = new Headers({
    "content-type": "application/json",
    authorization: `Bearer ${enqueueCredential(token)}`,
  });
  const ip = site.request.headers.get("cf-connecting-ip");
  if (ip !== null) headers.set("cf-connecting-ip", ip);
  const { formId, data, locale } = submission;
  const post = DeclaredPost.safeParse({
    formId,
    data,
    locale,
    fileFields: Object.keys(submission.files ?? {}),
  });
  if (!post.success) return { accepted: false, answer: invalid };
  const body = JSON.stringify(post.data);
  const reply = await callPlugin(
    handle,
    site.url,
    { plugin: pluginId, route: "declared/submit" },
    body,
    headers,
  );
  const parsed = DeclaredAnswer.safeParse("data" in reply ? reply.data : null);
  if (!parsed.success) return { accepted: false, answer: queueUnavailable };
  const value = parsed.data;
  if (value.success) return { accepted: true, answer: { success: true, data: value } };
  return {
    accepted: false,
    answer: {
      success: false,
      error: { code: value.code, message: value.message },
      ...(value.errors !== undefined && { data: { success: false, errors: value.errors } }),
    },
  };
}

/** The configured form and its public widget key, read in the same Worker. */
export async function getDeclaredForm(
  site: Pick<SiteRequest, "url" | "locals">,
  slug: string,
): Promise<RenderableForm | null> {
  if (!hasDeclaredForms(site.locals)) return null;
  const handle = getPublicPluginApiRouteHandler(site.locals);
  if (handle === undefined) return null;
  const result = await callPlugin(
    handle,
    site.url,
    { plugin: pluginId, route: "declared/definition" },
    JSON.stringify({ slug }),
    new Headers({ "content-type": "application/json" }),
  );
  if ("failure" in result) throw new Error("Could not read the Rondyr form definition");
  return RenderableForm.nullable().parse(result.data);
}

export function submitSiteForm(
  site: SiteRequest,
  submission: FormSubmission,
  token: string | null,
) {
  return hasDeclaredForms(site.locals)
    ? submitToDeclared(site, submission, token)
    : submitToForms(site, submission, token);
}

/**
 * The site's submission route, mounted by `route.ts` in place of the
 * template's `src/pages/api/form.ts`. `token` is `RONDYR_API_TOKEN`, or null.
 *
 * The contact block posts here with JavaScript (JSON `{ formId, data, files }`,
 * answered with the forms plugin's JSON) and without it (a form post, answered
 * with a redirect to the page with `?form=<block>&status=sent|error`). The forms
 * plugin validates and stores the submission in forms plugin mode. Declared
 * mode validates against the declaration and queues its text fields before
 * answering.
 */
export async function handleSubmission(site: SiteRequest, token: string | null) {
  const { request, url } = site;
  if (crossSite(request, url)) {
    return new Response("Cross-site form submission", { status: 403, headers: noStore });
  }
  const read = await readSubmission(request, hasDeclaredForms(site.locals));
  const json = (request.headers.get("content-type") ?? "")
    .toLowerCase()
    .startsWith("application/json");
  const submission = read.kind === "ok" ? read.submission : null;
  const { accepted, answer } =
    read.kind === "too-large"
      ? { accepted: false, answer: payloadTooLarge }
      : submission === null
        ? { accepted: false, answer: invalid }
        : await submitSiteForm(site, submission, token);

  if (json) {
    const headers = new Headers(noStore);
    let status = 400;
    if (accepted) {
      status = 200;
    } else if (answer === payloadTooLarge) {
      status = 413;
    } else if (!answer.success && answer.error.code === "RATE_LIMITED") {
      status = 429;
      headers.set("retry-after", rateLimitRetryAfter);
    } else if (answer === queueUnavailable) {
      status = 503;
    }
    return Response.json(answer, { status, headers });
  }
  const target = new URL(
    submission?.back !== null &&
      submission?.back !== undefined &&
      sameSitePath.test(submission.back)
      ? submission.back
      : "/",
    url,
  );
  if (
    submission?.block !== null &&
    submission?.block !== undefined &&
    blockKey.test(submission.block)
  ) {
    target.searchParams.set("form", submission.block);
    target.hash = `${submission.block}-status`;
  }
  target.searchParams.set("status", accepted ? "sent" : "error");
  // `/a/..//x` resolves to `//x`, which a browser would read as a host: one leading slash.
  const location = `${target.pathname.replace(/^\/+/u, "/")}${target.search}${target.hash}`;
  return new Response(null, { status: 303, headers: { location, ...noStore } });
}
