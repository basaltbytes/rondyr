// Serves /llms-full.txt, the concatenated plain-Markdown documentation for LLMs and coding agents.
import { renderLlmsFullTxt } from "../seo/llms.ts";
import { defaultSiteUrl } from "../site-url.ts";

import type { APIRoute } from "astro";

export const GET: APIRoute = ({ site }) => {
  const origin = site?.origin ?? defaultSiteUrl;
  return new Response(renderLlmsFullTxt(origin), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
};
