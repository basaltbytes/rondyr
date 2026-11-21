import type { APIRoute } from "astro";
import { z } from "astro/zod";
import { getPublicPluginApiRouteHandler } from "emdash/plugin-utils";

import { formsPluginId, pluginId } from "./constants.ts";
import { flattenFields, FormLayout, SubmittedData } from "./core/fields.ts";
import { enqueueCredential } from "./core/hop.ts";
import { rondyrSecrets } from "./secrets.ts";

export const prerender = false;

/** Fields the contact block adds for the no-JavaScript fallback; never part of a message. */
const pageFields = new Set(["formId", "_return", "_block"]);
/** The forms plugin's honeypot field, which the contact block names `_hp`. */
const honeypotField = "_hp";
const sameSitePath = /^\/(?![/\\])/u;
const blockKey = /^[\w-]{1,64}$/u;

const JsonBody = z.object({ formId: z.string().min(1).max(200), data: SubmittedData });

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

const Envelope = z.object({ success: z.boolean(), data: z.unknown().optional() });
const Accepted = z.object({ success: z.literal(true) });

type Handle = NonNullable<ReturnType<typeof getPublicPluginApiRouteHandler>>;

interface Submission {
  readonly formId: string;
  readonly data: SubmittedData;
  readonly back: string | null;
  readonly block: string | null;
}

async function readSubmission(request: Request): Promise<Submission | null> {
  const type = request.headers.get("content-type") ?? "";
  if (type.toLowerCase().startsWith("application/json")) {
    const parsed = JsonBody.safeParse(await request.json().catch(() => null));
    return parsed.success ? { ...parsed.data, back: null, block: null } : null;
  }
  const form = await request.formData().catch(() => null);
  if (form === null) return null;
  const data: SubmittedData = {};
  let formId = "";
  let back: string | null = null;
  let block: string | null = null;
  for (const [key, value] of form.entries()) {
    if (value instanceof File) continue;
    if (key === "formId") formId = value;
    else if (key === "_return") back = value;
    else if (key === "_block") block = value;
    else if (!pageFields.has(key)) data[key] = value;
  }
  return formId === "" ? null : { formId, data, back, block };
}

function pluginRequest(url: URL, path: string, body: string, headers: Headers): Request {
  return new Request(new URL(`/_emdash/api/plugins/${path}`, url), {
    method: "POST",
    headers,
    body,
  });
}

async function definitionOf(handle: Handle, url: URL, formId: string) {
  const headers = new Headers({ "content-type": "application/json" });
  const request = pluginRequest(
    url,
    `${formsPluginId}/definition`,
    JSON.stringify({ id: formId }),
    headers,
  );
  const result = Envelope.safeParse(await handle(formsPluginId, "POST", "/definition", request));
  if (!result.success || !result.data.success) return null;
  const definition = Definition.safeParse(result.data.data);
  return definition.success ? definition.data : null;
}

/**
 * Put an accepted submission in the Rondyr plugin's queue, in this Worker,
 * before the visitor gets the answer. A failure here is logged: the forms
 * plugin has stored the message, so the visitor still gets its answer.
 */
async function enqueue(
  handle: Handle,
  url: URL,
  definition: z.infer<typeof Definition>,
  data: SubmittedData,
): Promise<boolean> {
  const layout = FormLayout.parse({
    slug: definition.slug,
    name: definition.name,
    fields: definition.pages.flatMap(({ fields }) => fields),
  });
  const body = JSON.stringify({
    submissionId: crypto.randomUUID(),
    form: layout,
    fields: flattenFields(layout, data),
  });
  const headers = new Headers({
    "content-type": "application/json",
    authorization: `Bearer ${enqueueCredential(rondyrSecrets().token)}`,
  });
  const result = Envelope.safeParse(
    await handle(
      pluginId,
      "POST",
      "/enqueue",
      pluginRequest(url, `${pluginId}/enqueue`, body, headers),
    ),
  );
  // A failure is not the visitor's: the forms plugin stored the message, and
  // EmDash logs a failed route. The visitor gets the forms plugin's answer.
  return result.success && result.data.success;
}

/**
 * The site's submission route, in place of the template's `src/pages/api/form.ts`:
 * `export { POST, prerender } from "@basaltbytes/emdash-plugin-rondyr/route";`.
 *
 * The contact block posts here with JavaScript (JSON `{ formId, data }`, answered
 * with the forms plugin's JSON) and without it (a form post, answered with a
 * redirect to the page with `?form=<block>&status=sent|error`). The forms
 * plugin validates and stores the submission; once it accepts, the submission
 * goes to the Rondyr plugin's queue before the response.
 */
export const POST: APIRoute = async ({ request, url, locals, redirect }) => {
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
    const definition = await definitionOf(handle, url, submission.formId);
    const headers = new Headers(request.headers);
    headers.set("content-type", "application/json");
    headers.delete("content-length");
    // Built from the incoming request, so the forms plugin still sees the visitor's IP and country.
    const result = await handle(
      formsPluginId,
      "POST",
      "/submit",
      new Request(request, {
        method: "POST",
        headers,
        body: JSON.stringify({ formId: submission.formId, data: submission.data }),
      }),
    );
    answer = result;
    const envelope = Envelope.safeParse(result);
    accepted =
      envelope.success && envelope.data.success && Accepted.safeParse(envelope.data.data).success;
    // The forms plugin answers a filled honeypot like a success and stores nothing; so does Rondyr.
    const trap =
      definition?.settings?.spamProtection === "honeypot" &&
      Boolean(submission.data[honeypotField]);
    if (accepted && definition !== null && !trap) {
      await enqueue(handle, url, definition, submission.data);
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
  return redirect(`${target.pathname.replace(/^\/+/u, "/")}${target.search}${target.hash}`, 303);
};
