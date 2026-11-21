import type { APIRoute } from "astro";

import { rondyrSecrets } from "./secrets.ts";
import { handleSubmission } from "./site-route.ts";

export const prerender = false;

/**
 * The site's submission route, in place of the template's `src/pages/api/form.ts`:
 * `export { POST, prerender } from "@basaltbytes/emdash-plugin-rondyr/route";`.
 */
export const POST: APIRoute = ({ request, url, locals }) =>
  handleSubmission({ request, url, locals }, rondyrSecrets().token);
