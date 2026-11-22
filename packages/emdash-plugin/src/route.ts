import type { APIRoute } from "astro";

import { rondyrSecrets } from "./secrets.ts";
import {
  handleSubmission,
  submitSiteForm,
  type FormSubmission,
  type SiteRequest,
  type SubmitResult,
} from "./site-route.ts";

export { getDeclaredForm } from "./site-route.ts";
export type { RenderableForm } from "./declared-submission.ts";
export type { FormsAnswer, FormSubmission, SiteRequest, SubmitResult } from "./site-route.ts";

export const prerender = false;

/**
 * The site's submission route, in place of the template's `src/pages/api/form.ts`:
 * `export { POST, prerender } from "@basaltbytes/emdash-plugin-rondyr/route";`.
 */
export const POST: APIRoute = ({ request, url, locals }) =>
  handleSubmission({ request, url, locals }, rondyrSecrets().token);

/**
 * Submit a form from the site's own route or page, which then answers the
 * visitor its own way. Validation follows the mode set in `astro.config.mjs`.
 * Pass Astro's `request`, `url` and `locals` with the data the page has read.
 *
 * ```ts
 * const { accepted, answer } = await submitForm(Astro, { formId, data });
 * ```
 */
export function submitForm(site: SiteRequest, submission: FormSubmission): Promise<SubmitResult> {
  return submitSiteForm(site, submission, rondyrSecrets().token);
}
