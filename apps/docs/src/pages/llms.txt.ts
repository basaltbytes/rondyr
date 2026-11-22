// Serves /llms.txt, a concise Markdown documentation index for LLMs and coding agents.
import { renderLlmsTxt } from "../seo/llms.ts";
import { defaultSiteUrl } from "../site-url.ts";

import type { APIRoute } from "astro";

export const GET: APIRoute = ({ site }) => {
  const origin = site?.origin ?? defaultSiteUrl;
  return new Response(renderLlmsTxt(origin), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
};
