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
      fields: z.array(z.object({ name: z.string(), label: z.string(), type: z.string() })),
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

interface Submission {
  readonly formId: string;
  readonly data: SubmittedData;
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
  submission: Submission,
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
  const { request, url, locals } = site;
  // The plugin's own route refuses cross-site posts; called in-process it can't.
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== url.origin) {
    return new Response("Cross-site form submission", { status: 403 });
  }
  const handle = getPublicPluginApiRouteHandler(locals);
  const submission = await readSubmission(request);
  const json = (request.headers.get("content-type") ?? "")
    .toLowerCase()
    .startsWith("application/json");
  let accepted = false;
  let answer: Awaited<ReturnType<Handle>> = {
    success: false,
    error: { code: "INVALID_REQUEST", message: "Invalid form" },
  };

  if (handle !== undefined && submission !== null) {
    const headers = new Headers(request.headers);
    headers.set("content-type", "application/json");
    headers.delete("content-length");
    const body: z.input<typeof JsonBody> = { formId: submission.formId, data: submission.data };
    if (Object.keys(submission.files).length > 0) body.files = submission.files;
    // Built from the incoming request, so the forms plugin still sees the visitor's IP and country.
    const result = await handle(
      formsPluginId,
      "POST",
      "/submit",
      new Request(request, { method: "POST", headers, body: JSON.stringify(body) }),
    );
    answer = result;
    const envelope = Envelope.safeParse(result);
    accepted =
      envelope.success && envelope.data.success && Accepted.safeParse(envelope.data.data).success;
    if (accepted) {
      const definition = await definitionOf(handle, url, submission.formId);
      // The forms plugin answers a filled honeypot like a success and stores nothing; so does Rondyr.
      const trap =
        definition?.settings?.spamProtection === "honeypot" &&
        Boolean(submission.data[honeypotField]);
      if (!trap) await forward(handle, url, submission, definition, token);
    }
  }

  if (json) return Response.json(answer, { status: accepted ? 200 : 400 });
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
  return new Response(null, { status: 303, headers: { location } });
}
