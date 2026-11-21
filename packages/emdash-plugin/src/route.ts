import type { APIRoute } from "astro";

import { rondyrSecrets } from "./secrets.ts";
import {
  handleSubmission,
  submitToForms,
  type FormSubmission,
  type SiteRequest,
  type SubmitResult,
} from "./site-route.ts";

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
 * visitor its own way. The forms plugin validates and stores the submission;
 * once it accepts, the submission goes to the Rondyr plugin's queue before
 * this returns. Pass Astro's `request`, `url` and `locals`; the request's body
 * is not read, so a page that has already read the posted form can call it.
 *
 * ```ts
 * const { accepted, answer } = await submitForm(Astro, { formId, data });
 * ```
 */
export function submitForm(site: SiteRequest, submission: FormSubmission): Promise<SubmitResult> {
  return submitToForms(site, submission, rondyrSecrets().token);
}
