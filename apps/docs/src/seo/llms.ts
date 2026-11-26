// Builds /llms.txt, /llms-full.txt, /index.md, and per-page /*.md Markdown endpoints for AI agents.
import { existsSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { pathToFileURL } from "node:url";

import {
  comparisonRows,
  comparisonTradeoff,
  deployUrl,
  faqItems,
  formSnippet,
  landingMeta,
} from "../landing.ts";
import {
  documentId,
  githubBranch,
  githubRepository,
  listDocuments,
  pageRoute,
  readDocument,
  repositoryRoot,
} from "../repository/documents.ts";
import { sidebar } from "../sidebar.ts";

import type { DocumentSource } from "../repository/documents.ts";

/**
 * Finds the repository root both from source modules (`apps/docs/src/`) and from bundled
 * Astro route chunks (`apps/docs/dist/`), where `import.meta.url` shifts depth.
 */
function resolveRepositoryRoot(explicit?: URL): URL {
  if (explicit !== undefined) return explicit;
  if (existsSync(new URL("docs/deployment.md", repositoryRoot))) return repositoryRoot;
  let current = process.cwd();
  for (;;) {
    if (existsSync(join(current, "docs", "deployment.md"))) {
      return pathToFileURL(`${current}/`);
    }
    const parent = dirname(current);
    if (parent === current) return repositoryRoot;
    current = parent;
  }
}

function absoluteUrl(origin: string, route: string): string {
  return `${origin.replace(/\/+$/u, "")}${route}`;
}

/** Path of a documentation page's raw Markdown endpoint (`/deployment.md`). */
export function markdownRoute(id: string): string {
  return `/${id}.md`;
}

function rewriteMarkdownLinks(origin: string, documentPath: string, markdown: string): string {
  const directory = posix.dirname(documentPath);
  return markdown.replace(
    /(?<!!)\[([^\]]+)\]\(([^)\s]+)\)/gu,
    (match, label: string, target: string) => {
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/iu.test(target)) return match;
      const [rawPath = "", hash = ""] = target.split("#", 2);
      if (rawPath === "") return match;
      const normalized = posix.normalize(posix.join(directory, rawPath));
      if (normalized.startsWith("..")) return match;
      const suffix = hash === "" ? "" : `#${hash}`;
      const targetId = documentId(normalized);
      if (targetId !== null) {
        return `[${label}](${absoluteUrl(origin, pageRoute(targetId))}${suffix})`;
      }
      return `[${label}](${githubRepository}/blob/${githubBranch}/${normalized}${suffix})`;
    },
  );
}

/** Lists the user-facing documentation pages, resolving the repository root from bundled chunks too. */
export function listSiteDocuments(root?: URL): DocumentSource[] {
  return listDocuments(resolveRepositoryRoot(root));
}

function documentsById(root: URL): Map<string, DocumentSource> {
  return new Map(listDocuments(root).map((document) => [document.id, document]));
}

/** Renders a single documentation page as clean Markdown with absolute links. */
export function renderDocumentMarkdown(origin: string, slug: string, root?: URL): string {
  const cleanOrigin = origin.replace(/\/+$/u, "");
  const resolvedRoot = resolveRepositoryRoot(root);
  const source = documentsById(resolvedRoot).get(slug);
  if (source === undefined) {
    throw new Error(`Unknown documentation page for Markdown endpoint: ${slug}`);
  }
  const parsed = readDocument(source, resolvedRoot);
  const url = absoluteUrl(cleanOrigin, pageRoute(source.id));
  const cleanBody = rewriteMarkdownLinks(cleanOrigin, source.path, parsed.body)
    .replace(/!\[[^\]]*\]\(\.\/screenshots\/[^)]+\)\n*/gu, "")
    .trim();
  return [
    `# ${parsed.title}`,
    "",
    `Canonical URL: ${url}`,
    `Source: ${githubRepository}/blob/${githubBranch}/${source.path}`,
    "",
    cleanBody,
    "",
  ].join("\n");
}

/** Renders the landing page summary, comparison matrix, and FAQ as clean Markdown (`/index.md`). */
export function renderLandingMarkdown(origin: string, root?: URL): string {
  const cleanOrigin = origin.replace(/\/+$/u, "");
  const resolvedRoot = resolveRepositoryRoot(root);
  const byId = documentsById(resolvedRoot);
  const lines: string[] = [
    `# ${landingMeta.title}`,
    "",
    `> ${landingMeta.description}`,
    "",
    `- Website: ${cleanOrigin}/`,
    `- GitHub: ${githubRepository}`,
    `- One-click deploy: ${deployUrl}`,
    `- License: AGPL-3.0 (EmDash plugin: MIT)`,
    `- Full documentation bundle: ${cleanOrigin}/llms-full.txt`,
    "",
    "## Summary",
    "",
    "Rondyr is an open-source, self-hosted form backend with classifier-model spam filtering (Jev on Cloudflare Workers AI or OpenAI Decisions) that runs in your own Cloudflare account. Point any HTML `<form>` or JSON `fetch` call at Rondyr; every submission is saved first, screened for spam, unsolicited sales pitches, and business relevance, and either forwarded automatically or placed in a To review quarantine inbox so real messages are never silently deleted.",
    "",
    "## Example HTML form",
    "",
    "```html",
    formSnippet,
    "```",
    "",
    "## Rondyr vs. hosted form backends",
    "",
    "| Aspect | Rondyr (self-hosted) | Hosted form SaaS (Formspree, Basin, Web3Forms) |",
    "| --- | --- | --- |",
    ...comparisonRows.map((row) => `| ${row.aspect} | ${row.rondyr} | ${row.hosted} |`),
    "",
    comparisonTradeoff,
    "",
    "## Frequently asked questions",
    "",
    ...faqItems.flatMap((item) => [`### ${item.question}`, "", item.answer, ""]),
    "## Documentation",
    "",
  ];

  for (const group of sidebar) {
    lines.push(`### ${group.label}`, "");
    for (const item of group.items) {
      const source = byId.get(item.slug);
      if (source === undefined) continue;
      const parsed = readDocument(source, resolvedRoot);
      lines.push(
        `- [${parsed.title}](${absoluteUrl(cleanOrigin, markdownRoute(source.id))}) ([HTML](${absoluteUrl(cleanOrigin, pageRoute(source.id))}))`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** Renders the llmstxt.org Markdown index for the configured site origin. */
export function renderLlmsTxt(origin: string, root?: URL): string {
  const cleanOrigin = origin.replace(/\/+$/u, "");
  const resolvedRoot = resolveRepositoryRoot(root);
  const byId = documentsById(resolvedRoot);
  const lines: string[] = [
    "# Rondyr",
    "",
    `> ${landingMeta.description}`,
    "",
    "## At a glance",
    "",
    `- Category: Open-source, self-hosted form backend and spam gatekeeper (alternative to Formspree, Basin, Web3Forms, Getform, and Netlify Forms for static sites and web apps).`,
    `- Hosting and cost: Free open-source software (AGPL-3.0; EmDash plugin MIT). Runs in your own Cloudflare account (deploy and test-drive on Workers Free; Workers Paid at $5/month per account for production) with no per-form or per-submission SaaS markup.`,
    `- Deployment: One-click Deploy to Cloudflare button (${deployUrl}), or from a GitHub fork with Alchemy and GitHub Actions.`,
    `- Spam filtering: Classifier models (Jev on Workers AI by default, or OpenAI Decisions via Cloudflare AI Gateway unified billing) score spam, unsolicited sales outreach, and relevance to your business description, layered with honeypot fields, Cloudflare Turnstile, allowed origins, rate limits, and repeat detection.`,
    `- Quarantine: Doubtful messages wait in To review with a plain reason until a person accepts or archives them; real inquiries are never silently deleted.`,
    `- Integrations: Plain HTML forms, cross-origin JSON fetch (Astro, Next.js, Hugo, Eleventy, Jekyll, SvelteKit), server HTTP API with idempotency keys, Resend, Cloudflare Email Sending, HMAC-SHA-256 webhooks, Discord, Slack, Airtable, and EmDash CMS.`,
    `- Trade-offs: ${comparisonTradeoff}`,
    "",
    "## Machine-readable entrypoints",
    "",
    `- [Overview and FAQ (Markdown)](${cleanOrigin}/index.md): Landing page summary, hosted-SaaS comparison, and FAQ.`,
    `- [Complete documentation in one file](${cleanOrigin}/llms-full.txt): All user-facing documentation pages concatenated into a single Markdown document.`,
    `- [Homepage (HTML)](${cleanOrigin}/)`,
    `- [GitHub repository](${githubRepository})`,
  ];

  for (const group of sidebar) {
    lines.push("", `## ${group.label}`, "");
    for (const item of group.items) {
      const source = byId.get(item.slug);
      if (source === undefined) continue;
      const parsed = readDocument(source, resolvedRoot);
      const mdUrl = absoluteUrl(cleanOrigin, markdownRoute(source.id));
      const summary = parsed.description === "" ? "" : `: ${parsed.description}`;
      lines.push(`- [${parsed.title}](${mdUrl})${summary}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

/** Renders the concatenated plain-Markdown documentation for LLMs and coding agents. */
export function renderLlmsFullTxt(origin: string, root?: URL): string {
  const cleanOrigin = origin.replace(/\/+$/u, "");
  const resolvedRoot = resolveRepositoryRoot(root);
  const byId = documentsById(resolvedRoot);
  const sections: string[] = [
    "# Rondyr Documentation",
    "",
    `> ${landingMeta.description}`,
    "",
    `Source: ${cleanOrigin}/`,
    `Repository: ${githubRepository}`,
    "",
    "---",
    "",
    renderLandingMarkdown(cleanOrigin, resolvedRoot).trim(),
  ];

  for (const group of sidebar) {
    for (const item of group.items) {
      const source = byId.get(item.slug);
      if (source === undefined) continue;
      sections.push(
        "",
        "---",
        "",
        renderDocumentMarkdown(cleanOrigin, source.id, resolvedRoot).trim(),
      );
    }
  }

  sections.push("");
  return sections.join("\n");
}
