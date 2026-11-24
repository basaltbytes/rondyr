// Links in the repository's Markdown are written for GitHub: `./webhooks.md#signature`,
// `../CONTRIBUTING.md`, `examples/verify-webhook.ts`. On the site, a link to another page
// goes to that page's route, and a link to any other file of the repository goes to the
// file on GitHub. A link to a file that does not exist, or to a heading that a Markdown
// file outside the site does not have, fails the build.
import { existsSync, readFileSync, statSync } from "node:fs";
import { posix, relative, sep } from "node:path";

import GithubSlugger from "github-slugger";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toString } from "mdast-util-to-string";
import { visit } from "unist-util-visit";

import {
  documentId,
  githubBranch,
  githubRepository,
  pageRoute,
  parseDocument,
  repositoryPath,
  repositoryRoot,
} from "./documents.ts";

import type { Definition, Image, Link, Root } from "mdast";
import type { VFile } from "vfile";

/** A link of a page, resolved against the repository. */
export type ResolvedLink =
  | { readonly kind: "unchanged" }
  | { readonly kind: "rewritten"; readonly url: string; readonly title?: string }
  | { readonly kind: "broken"; readonly reason: string };

const scheme = /^[a-z][a-z\d+.-]*:/iu;

/** Link text that is a Markdown file name, such as `deployment.md` or `docs/api.md`. */
const fileName = /^[\w./-]+\.md$/u;

/** The heading anchors of a Markdown file, as GitHub generates them. */
function githubAnchors(source: string): Set<string> {
  const slugger = new GithubSlugger();
  const anchors = new Set<string>();
  visit(fromMarkdown(source), "heading", (heading) => {
    anchors.add(slugger.slug(toString(heading)));
  });
  return anchors;
}

/**
 * Resolves the URL of a link or an image in the page at `sourcePath`, a path from the
 * repository root. Absolute URLs, site paths and anchors in the same page stay as they are.
 */
export function resolveLink(
  url: string,
  sourcePath: string,
  isImage = false,
  root: URL = repositoryRoot,
): ResolvedLink {
  if (url === "" || url.startsWith("#") || url.startsWith("/") || scheme.test(url)) {
    return { kind: "unchanged" };
  }
  const hashAt = url.indexOf("#");
  const hash = hashAt === -1 ? "" : url.slice(hashAt);
  let target: string;
  try {
    target = decodeURI(hashAt === -1 ? url : url.slice(0, hashAt)).replace(/\?.*$/u, "");
  } catch {
    return { kind: "broken", reason: `${url} is not a valid URL` };
  }
  const path = posix.normalize(posix.join(posix.dirname(sourcePath), target)).replace(/\/$/u, "");
  if (path === ".." || path.startsWith("../")) {
    return { kind: "broken", reason: `${url} points outside the repository` };
  }
  const file = repositoryPath(path === "." ? "" : path, root);
  if (!existsSync(file)) {
    return { kind: "broken", reason: `${url} points to ${path}, which does not exist` };
  }
  const directory = statSync(file).isDirectory();
  const id = directory ? null : documentId(path);
  if (id !== null) {
    const { title } = parseDocument(path, readFileSync(file, "utf8"));
    return { kind: "rewritten", url: `${pageRoute(id)}${hash}`, title };
  }
  // Images stay relative, so that Astro copies them into the site with the page.
  if (isImage) return { kind: "unchanged" };
  if (!directory && hash !== "" && path.endsWith(".md")) {
    let anchor: string;
    try {
      anchor = decodeURIComponent(hash.slice(1));
    } catch {
      return { kind: "broken", reason: `${url} has an invalid anchor` };
    }
    if (!githubAnchors(readFileSync(file, "utf8")).has(anchor)) {
      return { kind: "broken", reason: `${url} points to a heading that ${path} does not have` };
    }
  }
  const view = directory ? "tree" : "blob";
  const location = path === "." ? "" : `/${path}`;
  return {
    kind: "rewritten",
    url: `${githubRepository}/${view}/${githubBranch}${location}${hash}`,
  };
}

/** The repository path of a rendered file, or null when the file is not a page. */
function sourcePathOf(file: VFile, root: URL): string | null {
  if (file.path === undefined) return null;
  const path = relative(repositoryPath("", root), file.path).split(sep).join("/");
  return documentId(path) === null ? null : path;
}

/**
 * On GitHub, a link whose text is a file name, such as `[deployment.md](./deployment.md)`,
 * names the file to open. On the site, the link shows the title of the page instead.
 */
function retitle(link: Link, title: string): void {
  const [child, ...rest] = link.children;
  if (child === undefined || rest.length > 0) return;
  if (child.type !== "text" && child.type !== "inlineCode") return;
  if (fileName.test(child.value)) link.children = [{ type: "text", value: title }];
}

/** A remark plugin that applies `resolveLink` to every link, definition and image of a page. */
export function remarkRepositoryLinks(root: URL = repositoryRoot) {
  return () =>
    (tree: Root, file: VFile): void => {
      const sourcePath = sourcePathOf(file, root);
      if (sourcePath === null) return;
      const broken: string[] = [];
      visit(tree, (node) => {
        if (node.type !== "link" && node.type !== "definition" && node.type !== "image") return;
        const target: Link | Definition | Image = node;
        const resolved = resolveLink(target.url, sourcePath, target.type === "image", root);
        if (resolved.kind === "rewritten") {
          target.url = resolved.url;
          if (target.type === "link" && resolved.title !== undefined)
            retitle(target, resolved.title);
        }
        if (resolved.kind === "broken") {
          broken.push(`${sourcePath}:${target.position?.start.line ?? 0}: ${resolved.reason}`);
        }
      });
      if (broken.length > 0) {
        throw new Error(`Broken links in ${sourcePath}:\n${broken.join("\n")}`);
      }
    };
}
