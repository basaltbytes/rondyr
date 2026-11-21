// Checks the built site: every link, image, stylesheet and script that points into the site
// must reach a built file, and a link with an anchor must reach an element with that ID.
// It covers the Markdown pages, the landing page, the navigation and the theme together.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { fromHtml } from "hast-util-from-html";
import { visit } from "unist-util-visit";

import type { AstroIntegration } from "astro";
import type { Element } from "hast";

/** The attribute that holds a URL, for each element the check reads. */
const urlAttributes: ReadonlyMap<string, "href" | "src"> = new Map([
  ["a", "href"],
  ["img", "src"],
  ["link", "href"],
  ["script", "src"],
  ["source", "src"],
]);

/**
 * The `<link>` relations that load a file. A canonical or alternate address names a page
 * instead, and Starlight gives its 404 page the canonical address `/404/`.
 */
const loadedRelations = new Set(["icon", "stylesheet", "preload", "modulepreload", "manifest"]);

function loadsFile(node: Element): boolean {
  if (node.tagName !== "link") return true;
  const rel = node.properties["rel"];
  return Array.isArray(rel) && rel.some((relation) => loadedRelations.has(String(relation)));
}

interface BuiltPage {
  readonly ids: ReadonlySet<string>;
  readonly urls: readonly string[];
}

function readPage(file: string): BuiltPage {
  const ids = new Set<string>();
  const urls: string[] = [];
  visit(fromHtml(readFileSync(file, "utf8")), "element", (node: Element) => {
    // hast parses `id`, `href` and `src` as strings.
    const id = node.properties["id"];
    if (id !== undefined && id !== null) ids.add(String(id));
    const attribute = urlAttributes.get(node.tagName);
    if (attribute === undefined || !loadsFile(node)) return;
    const value = node.properties[attribute];
    if (value !== undefined && value !== null && value !== "") urls.push(String(value));
  });
  return { ids, urls };
}

/** The site path of a built HTML file: `api/index.html` is `/api/`. */
function pagePath(relativeFile: string): string {
  const path = `/${relativeFile.split(sep).join("/")}`;
  return path.endsWith("/index.html") ? path.slice(0, -"index.html".length) : path;
}

/** The built file that answers a site path, or null when there is none. */
function builtFile(directory: string, path: string): string | null {
  const local = join(directory, ...decodeURIComponent(path).split("/"));
  const candidates = path.endsWith("/")
    ? [join(local, "index.html")]
    : [local, join(local, "index.html"), `${local}.html`];
  return (
    candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null
  );
}

/** The broken internal links of the site built in `directory`, served at `site`. */
export function findBrokenLinks(directory: string, site: string): string[] {
  const files = readdirSync(directory, { recursive: true, encoding: "utf8" }).filter((file) =>
    file.endsWith(".html"),
  );
  const pages = new Map<string, BuiltPage>();
  for (const file of files) pages.set(join(directory, file), readPage(join(directory, file)));
  const origin = new URL(site).origin;
  const broken: string[] = [];
  for (const file of files) {
    const page = pages.get(join(directory, file));
    if (page === undefined) continue;
    const from = pagePath(file);
    for (const value of page.urls) {
      const url = new URL(value, `${origin}${from}`);
      if (url.origin !== origin) continue;
      const target = builtFile(directory, url.pathname);
      if (target === null) {
        broken.push(`${from}: ${value} has no page or file`);
        continue;
      }
      const anchor = decodeURIComponent(url.hash.slice(1));
      if (anchor === "" || !target.endsWith(".html")) continue;
      if (!(pages.get(target)?.ids.has(anchor) ?? false)) {
        broken.push(`${from}: ${value} points to an anchor that ${url.pathname} does not have`);
      }
    }
  }
  return broken;
}

/** An Astro integration that fails the build when the built site has a broken internal link. */
export function builtLinks(): AstroIntegration {
  let site = "";
  return {
    name: "rondyr-built-links",
    hooks: {
      "astro:config:done": ({ config }) => {
        site = config.site ?? "http://localhost";
      },
      "astro:build:done": ({ dir, logger }) => {
        const broken = findBrokenLinks(fileURLToPath(dir), site);
        if (broken.length > 0) {
          throw new Error(`${broken.length} broken links in the built site:\n${broken.join("\n")}`);
        }
        logger.info("Every internal link and anchor of the built site resolves.");
      },
    },
  };
}
