// Checks the site that `astro build` wrote to dist/.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { fromHtml } from "hast-util-from-html";
import { toString } from "hast-util-to-string";
import { visit } from "unist-util-visit";

import {
  listDocuments,
  pageRoute,
  readDocument,
  repositoryPath,
} from "../src/repository/documents.ts";
import { sidebar } from "../src/sidebar.ts";

import type { Element, Root } from "hast";

const dist = new URL("../dist/", import.meta.url);

function built(path: string): string {
  return readFileSync(new URL(path, dist), "utf8");
}

function builtPage(route: string): Root {
  return fromHtml(built(`${route.slice(1)}index.html`));
}

function elements(tree: Root, match: (node: Element) => boolean): Element[] {
  const found: Element[] = [];
  visit(tree, "element", (node: Element) => {
    if (match(node)) found.push(node);
  });
  return found;
}

function hasClass(node: Element, name: string): boolean {
  const className = node.properties["className"];
  return Array.isArray(className) && className.includes(name);
}

function hrefs(tree: Root | Element): string[] {
  const found: string[] = [];
  visit(tree, "element", (node: Element) => {
    const href = node.properties["href"];
    if (node.tagName === "a" && href !== undefined && href !== null) found.push(String(href));
  });
  return found;
}

const documents = listDocuments();

test("builds a page for every Markdown file, titled with its first heading", () => {
  for (const document of documents) {
    const tree = builtPage(pageRoute(document.id));
    const [title] = elements(tree, (node) => node.tagName === "h1");
    assert.ok(title !== undefined, document.path);
    assert.equal(toString(title).trim(), readDocument(document).title, document.path);
    assert.equal(elements(tree, (node) => node.tagName === "h1").length, 1, document.path);
  }
});

test("gives each page the description of its first paragraph", () => {
  for (const document of documents) {
    const { description } = readDocument(document);
    const [meta] = elements(
      builtPage(pageRoute(document.id)),
      (node) => node.tagName === "meta" && node.properties["name"] === "description",
    );
    assert.equal(meta?.properties["content"], description, document.path);
  }
});

test("lists every page in the sidebar and in the mobile menu, in the navigation order", () => {
  const order = sidebar.flatMap(({ items }) => items.map(({ slug }) => pageRoute(slug)));
  const tree = builtPage("/api/");
  const [desktop] = elements(tree, (node) => hasClass(node, "sidebar-entries"));
  // The mobile menu lists the header links first, then the pages under `.links-docs`.
  const [drawer] = elements(tree, (node) => hasClass(node, "links-docs"));
  assert.ok(desktop !== undefined && drawer !== undefined);
  for (const container of [desktop, drawer]) {
    assert.deepEqual(
      hrefs(container).filter((href) => order.includes(href)),
      order,
    );
  }
});

test("indexes every page for search", () => {
  const entry: { languages: { en: { page_count: number } } } = JSON.parse(
    built("pagefind/pagefind-entry.json"),
  );
  // The pages of the repository and the landing page.
  assert.equal(entry.languages.en.page_count, documents.length + 1);
});

test("leaves out the production address that architecture.md gives", () => {
  const source = readFileSync(repositoryPath("architecture.md"), "utf8");
  const address = /\*\*Production:\*\*\s*`([^`]+)`/u.exec(source)?.[1];
  if (address === undefined) return;
  const host = new URL(address).host;
  const files = readdirSync(dist, { recursive: true, encoding: "utf8" }).filter((file) =>
    /\.(html|xml|json|js|css|txt)$/u.test(file),
  );
  for (const file of files) assert.ok(!built(file).includes(host), `${file} contains ${host}`);
});

test("links files of the repository that are not pages to GitHub", () => {
  assert.ok(
    hrefs(builtPage("/webhooks/")).includes(
      "https://github.com/basaltbytes/rondyr/blob/main/docs/examples/verify-webhook.ts",
    ),
  );
});

test("links pages to each other by route, with the page title for a file name", () => {
  // docs/webhooks.md has `[deployment.md](./deployment.md#encryption-key)`.
  const links = elements(
    builtPage("/webhooks/"),
    (node) => node.tagName === "a" && node.properties["href"] === "/deployment/#encryption-key",
  );
  assert.ok(links.length > 0);
  for (const link of links) assert.equal(toString(link), "Deployment");
});

test("renders the Mermaid diagram of architecture.md as an SVG", () => {
  const [diagram] = elements(builtPage("/architecture/"), (node) => hasClass(node, "diagram"));
  assert.ok(diagram !== undefined);
  assert.equal(
    elements({ type: "root", children: [diagram] }, (node) => node.tagName === "svg").length,
    1,
  );
});

test("serves the Rondyr mark from docs/brand/ as the favicon", () => {
  assert.equal(
    built("favicon.svg"),
    readFileSync(repositoryPath("docs/brand/rondyr-mark.svg"), "utf8"),
  );
  const icons = elements(
    builtPage("/"),
    (node) => node.tagName === "link" && node.properties["href"] === "/favicon.svg",
  );
  assert.equal(icons.length, 1);
});

test("shows a light and a dark wordmark in the header", () => {
  const logos = elements(
    builtPage("/api/"),
    (node) => node.tagName === "img" && hasClass(node, "logo"),
  );
  assert.equal(logos.length, 2);
  for (const logo of logos) assert.equal(logo.properties["alt"], "Rondyr");
});

test("the landing page has the Deploy to Cloudflare button, the plan and the first run", () => {
  const tree = builtPage("/");
  const [button] = elements(
    tree,
    (node) =>
      node.tagName === "a" &&
      node.properties["href"] ===
        "https://deploy.workers.cloudflare.com/?url=https://github.com/basaltbytes/rondyr",
  );
  assert.ok(button !== undefined);
  const [image] = elements({ type: "root", children: [button] }, (node) => node.tagName === "img");
  assert.equal(image?.properties["src"], "https://deploy.workers.cloudflare.com/button");
  assert.equal(image?.properties["alt"], "Deploy to Cloudflare");
  const text = toString(tree);
  assert.match(text, /Workers Paid/u);
  assert.match(text, /action="https:\/\/rondyr\.example\.com\/f\/YOUR_PUBLIC_ID"/u);
  const steps = elements(
    tree,
    (node) =>
      node.tagName === "li" &&
      node.children.some((child) => child.type === "element" && child.tagName === "h3"),
  );
  assert.equal(steps.length, 3);
  for (const document of documents)
    assert.ok(hrefs(tree).includes(pageRoute(document.id)), document.path);
});
