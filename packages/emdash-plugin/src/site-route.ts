import { z } from "astro/zod";
import {
  getPublicPluginApiRouteHandler,
  type PublicPluginRuntimeLocals,
} from "emdash/plugin-utils";

import { formsPluginId, pluginId } from "./constants.ts";
import { flattenFields, formLayout, SubmittedData, type FormLayout } from "./core/fields.ts";
import { enqueueCredential } from "./core/hop.ts";

/** The forms plugin's honeypot field, which the contact block names `_hp`. */
const honeypotField = "_hp";
const sameSitePath = /^\/(?![/\\])/u;
const blockKey = /^[\w-]{1,64}$/u;
const errorCode = /^[\w-]{1,64}$/u;

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
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function readSubmission(request: Request): Promise<Submission | null> {
  const type = request.headers.get("content-type") ?? "";
  if (type.toLowerCase().startsWith("application/json")) {
    const parsed = JsonBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return null;
    const { formId, data, files } = parsed.data;
    return { formId, data, files: files ?? {}, back: null, block: null };
  }
  const form = await request.formData().catch(() => null);
  if (form === null) return null;
  const data: Record<string, string | string[]> = {};
  const files: Record<string, SubmittedFile> = {};
  let formId = "";
  let back: string | null = null;
  let block: string | null = null;
  for (const [key, value] of form.entries()) {
    if (value instanceof File) {
      // An empty file input still posts a nameless, empty file.
      if (value.size > 0) {
        files[key] = {
          filename: value.name,
          contentType: value.type === "" ? "application/octet-stream" : value.type,
          bytes: base64(new Uint8Array(await value.arrayBuffer())),
        };
      }
      continue;
    }
    if (key === "formId") formId = value;
    else if (key === "_return") back = value;
    else if (key === "_block") block = value;
    else {
      // A repeated name, such as a checkbox group, becomes a list, as with JavaScript.
      const previous = data[key];
      data[key] =
        previous === undefined
          ? value
          : Array.isArray(previous)
            ? [...previous, value]
            : [previous, value];
    }
  }
  return formId === "" ? null : { formId, data, files, back, block };
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

/**
 * Put an accepted submission in the Rondyr plugin's queue, in this Worker,
 * before the visitor gets the answer. `enqueue` is idempotent, so a failed call
 * is made once more. When both fail, the plugin records it: the admin pages
 * then say how many submissions of the form were not queued, and its log says
 * why. The forms plugin keeps its copy, and the visitor gets its answer anyway.
 */
async function forward(
  handle: Handle,
  url: URL,
  submission: FormSubmission,
  definition: Definition | null,
  token: string | null,
): Promise<void> {
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
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await callPlugin(handle, url, target, body, headers);
      if ("data" in result) return;
      failure = result.failure;
    }
  }
  const form = definition === null ? submission.formId : definition.slug;
  const report = JSON.stringify({ form: form.slice(0, 200), code: failure });
  await callPlugin(handle, url, { plugin: pluginId, route: "enqueue/failed" }, report, headers);
}

/** What the site route reads from Astro's context. */
export interface SiteRequest {
  readonly request: Request;
  readonly url: URL;
  readonly locals: PublicPluginRuntimeLocals;
}

const invalid: FormsAnswer = {
  success: false,
  error: { code: "INVALID_REQUEST", message: "Invalid form" },
};

/**
 * Submit to the forms plugin in this Worker and, once it accepts, put the
 * submission in the Rondyr plugin's queue before returning, without its files.
 * `site.request` is the visitor's request: the forms plugin reads the
 * visitor's IP and country from its headers, and its body is not read.
 * `token` is `RONDYR_API_TOKEN`, or null.
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
  const body: z.input<typeof JsonBody> = { formId: submission.formId, data: submission.data };
  const files = submission.files ?? {};
  if (Object.keys(files).length > 0) body.files = files;
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
    if (!trap) await forward(handle, url, submission, definition, token);
  }
  return { accepted, answer: formsAnswer(answer) };
}

/**
 * The site's submission route, mounted by `route.ts` in place of the
 * template's `src/pages/api/form.ts`. `token` is `RONDYR_API_TOKEN`, or null.
 *
 * The contact block posts here with JavaScript (JSON `{ formId, data, files }`,
 * answered with the forms plugin's JSON) and without it (a form post, answered
 * with a redirect to the page with `?form=<block>&status=sent|error`). The forms
 * plugin validates and stores the submission, files included; once it accepts,
 * the submission goes to the Rondyr plugin's queue before the response, without
 * its files.
 */
export async function handleSubmission(site: SiteRequest, token: string | null) {
  const { request, url } = site;
  if (crossSite(request, url)) {
    return new Response("Cross-site form submission", { status: 403, headers: noStore });
  }
  const submission = await readSubmission(request);
  const json = (request.headers.get("content-type") ?? "")
    .toLowerCase()
    .startsWith("application/json");
  const { accepted, answer } =
    submission === null
      ? { accepted: false, answer: invalid }
      : await submitToForms(site, submission, token);

  if (json) return Response.json(answer, { status: accepted ? 200 : 400, headers: noStore });
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
