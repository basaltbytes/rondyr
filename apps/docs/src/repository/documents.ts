// The pages of the site are Markdown files under `docs/`, read where they are, excluding
// contributor-only material that stays on GitHub. They have no frontmatter; the title is
// the first-level heading and the description is the first paragraph.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { fromMarkdown } from "mdast-util-from-markdown";
import { toString } from "mdast-util-to-string";

import type { Heading, Paragraph } from "mdast";

/** The repository root, four levels above this file in `apps/docs/src/repository/`. */
export const repositoryRoot: URL = new URL("../../../../", import.meta.url);

/** The repository on GitHub, where links to files that are not pages go. */
export const githubRepository = "https://github.com/basaltbytes/rondyr";

/** The branch that GitHub links and edit links point to. */
export const githubBranch = "main";

/** A Markdown file of the repository that the site renders as a page. */
export interface DocumentSource {
  /** The path from the repository root, with forward slashes: `docs/api.md`. */
  readonly path: string;
  /** The page's ID and URL path without slashes: `api` for `/api/`. */
  readonly id: string;
}

/** The title, the description and the Markdown body of a page, without its first heading. */
export interface ParsedDocument {
  readonly title: string;
  readonly description: string;
  readonly body: string;
}

/**
 * Contributor-only Markdown files under `docs/` that stay in the repository on GitHub
 * rather than becoming pages on the documentation site.
 */
export const contributorDocuments: ReadonlySet<string> = new Set([
  "docs/evaluation.md",
  "docs/local-development.md",
  "docs/operations.md",
  "docs/writing-a-connector.md",
]);

/** The longest meta description kept whole; a longer paragraph is cut after a sentence. */
const descriptionLength = 200;

/** The page ID of a repository path, or null when the file is not a page. */
export function documentId(path: string): string | null {
  if (contributorDocuments.has(path)) return null;
  const match = /^docs\/(.+)\.md$/u.exec(path);
  return match?.[1] ?? null;
}

/** The site route of a page ID. */
export function pageRoute(id: string): string {
  return `/${id}/`;
}

/** The Markdown pages of the repository, sorted by path. */
export function listDocuments(root: URL = repositoryRoot): DocumentSource[] {
  const docs = readdirSync(new URL("docs/", root), { recursive: true, encoding: "utf8" })
    .map((entry) => `docs/${entry.split("\\").join("/")}`)
    .filter((path) => path.endsWith(".md"));
  const sources = docs.toSorted().flatMap((path) => {
    const id = documentId(path);
    return id === null ? [] : [{ path, id }];
  });
  const seen = new Map<string, string>();
  for (const { path, id } of sources) {
    const other = seen.get(id);
    if (other !== undefined) {
      throw new Error(`${path} and ${other} would both be served at ${pageRoute(id)}.`);
    }
    seen.set(id, path);
  }
  return sources;
}

/** The absolute path of a repository file. */
export function repositoryPath(path: string, root: URL = repositoryRoot): string {
  return fileURLToPath(new URL(path, root));
}

/** Keeps the first sentences of a paragraph, up to `descriptionLength` characters. */
function shorten(text: string): string {
  if (text.length <= descriptionLength) return text;
  const sentences = text.match(/[^.!?]+[.!?]+(?:\s+|$)/gu) ?? [text];
  let kept = "";
  for (const sentence of sentences) {
    if (kept !== "" && kept.length + sentence.length > descriptionLength) break;
    kept += sentence;
  }
  return kept.trim();
}

/**
 * Reads the title, description and body of a page from its Markdown source. The first
 * first-level heading is the title and is removed from the body, because the page layout
 * shows the title itself. The first paragraph of the file becomes the description.
 */
export function parseDocument(path: string, source: string): ParsedDocument {
  const tree = fromMarkdown(source);
  const heading = tree.children.find(
    (node): node is Heading => node.type === "heading" && node.depth === 1,
  );
  if (heading === undefined) {
    throw new Error(`${path} has no first-level heading (# Title); the page title comes from it.`);
  }
  const paragraph = tree.children.find((node): node is Paragraph => node.type === "paragraph");
  const start = heading.position?.start.offset ?? 0;
  const end = heading.position?.end.offset ?? 0;
  return {
    title: toString(heading).trim(),
    description: paragraph === undefined ? "" : shorten(toString(paragraph).replace(/\s+/gu, " ")),
    body: source.slice(0, start) + source.slice(end).replace(/^\s*\n/u, ""),
  };
}

/** Reads and parses a page of the repository. */
export function readDocument(document: DocumentSource, root: URL = repositoryRoot): ParsedDocument {
  return parseDocument(document.path, readFileSync(repositoryPath(document.path, root), "utf8"));
}
