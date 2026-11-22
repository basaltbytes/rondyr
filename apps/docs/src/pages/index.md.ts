// Serves /index.md, a clean Markdown mirror of the landing page for AI agents and coding assistants.
import { renderLandingMarkdown } from "../seo/llms.ts";
import { defaultSiteUrl } from "../site-url.ts";

import type { APIRoute } from "astro";

export const GET: APIRoute = ({ site }) => {
  const origin = site?.origin ?? defaultSiteUrl;
  return new Response(renderLandingMarkdown(origin), {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
};
