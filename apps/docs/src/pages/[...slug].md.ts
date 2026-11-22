// Serves /<slug>.md for every documentation page so AI agents can fetch clean Markdown directly.
import { listSiteDocuments, renderDocumentMarkdown } from "../seo/llms.ts";
import { defaultSiteUrl } from "../site-url.ts";

import type { APIRoute, GetStaticPaths } from "astro";

export const getStaticPaths: GetStaticPaths = () =>
  listSiteDocuments().map(({ id }) => ({ params: { slug: id } }));

export const GET: APIRoute = ({ params, site }) => {
  const origin = site?.origin ?? defaultSiteUrl;
  const slug = params["slug"] ?? "";
  return new Response(renderDocumentMarkdown(origin, slug), {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
};
