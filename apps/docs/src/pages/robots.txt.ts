// Generates robots.txt for the configured site origin, welcoming search and AI crawlers.
import { defaultSiteUrl } from "../site-url.ts";

import type { APIRoute } from "astro";

/** AI search, assistant, and model crawlers explicitly welcomed alongside general crawlers. */
export const aiCrawlers: readonly string[] = [
  "OAI-SearchBot",
  "GPTBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-SearchBot",
  "Claude-User",
  "anthropic-ai",
  "Googlebot",
  "Google-Extended",
  "PerplexityBot",
  "Perplexity-User",
  "Applebot",
  "Applebot-Extended",
  "DuckAssistBot",
  "bingbot",
];

/** Formats robots.txt for the given origin with Content-Signal and explicit AI crawler allow rules. */
export function renderRobotsTxt(origin: string): string {
  const cleanOrigin = origin.replace(/\/+$/u, "");
  const lines = [
    "User-agent: *",
    "Content-Signal: search=yes, ai-input=yes, ai-train=yes",
    "Allow: /",
    "",
    ...aiCrawlers.flatMap((crawler) => [`User-agent: ${crawler}`, "Allow: /", ""]),
    `# Machine-readable documentation index for AI agents: ${cleanOrigin}/llms.txt`,
    `Sitemap: ${cleanOrigin}/sitemap-index.xml`,
    "",
  ];
  return lines.join("\n");
}

export const GET: APIRoute = ({ site }) => {
  const origin = site?.origin ?? defaultSiteUrl;
  return new Response(renderRobotsTxt(origin), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
};
