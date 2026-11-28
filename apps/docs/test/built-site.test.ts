// Checks the site that `astro build` wrote to dist/.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { fromHtml } from "hast-util-from-html";
import { toString } from "hast-util-to-string";
import { visit } from "unist-util-visit";

import { captionsOf, lifecycleSteps, messages, story } from "../src/lifecycle.ts";
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

/**
 * The site documents Rondyr for people who deploy their own copy, so it never shows the
 * address of the maintainers' instance.
 */
const maintainerHosts = ["rondyr.basaltbytes.com"];

test("contains no address of the maintainers' instance", () => {
  const files = readdirSync(dist, { recursive: true, encoding: "utf8" }).filter((file) =>
    /\.(html|xml|json|js|css|txt|md)$/u.test(file),
  );
  const found = files.flatMap((file) =>
    maintainerHosts.filter((host) => built(file).includes(host)).map((host) => `${file}: ${host}`),
  );
  assert.deepEqual(
    found,
    [],
    "Remove the address from the Markdown file that the page comes from.",
  );
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
  for (const link of links) assert.equal(toString(link), "Deploy Rondyr");
});

test("links contributor material to GitHub from the contributing page", () => {
  const links = hrefs(builtPage("/contributing/"));
  assert.ok(links.includes("https://github.com/basaltbytes/rondyr/blob/main/CONTRIBUTING.md"));
  assert.ok(links.includes("https://github.com/basaltbytes/rondyr/blob/main/AGENTS.md"));
  assert.ok(
    links.includes("https://github.com/basaltbytes/rondyr/blob/main/docs/local-development.md"),
  );
  assert.ok(links.includes("https://github.com/basaltbytes/rondyr/blob/main/docs/evaluation.md"));
});

test("contains no Worker internals on any page of the site", () => {
  const forbidden = [
    /\bworkerd\b/iu,
    /\bD1\b/u,
    /\boutbox_events\b/u,
    /\bd1_migrations\b/u,
    /\bSubmissionAggregate\b/u,
    /\bDurable Objects?\b/iu,
    /\bdead-letter\b/iu,
    /\bqueues?\b/iu,
    /\bconsumers?\b/iu,
    /\bclassification-queue\b/u,
    /\bdelivery-queue\b/u,
    /\bsubmission_inbox\b/u,
    /\bnotification_targets\b/u,
  ];
  const pages = ["/", ...documents.map(({ id }) => pageRoute(id))];
  const hits: string[] = [];
  for (const route of pages) {
    const [main] = elements(builtPage(route), (node) => node.tagName === "main");
    const text = main === undefined ? "" : toString(main);
    for (const pattern of forbidden) {
      const match = pattern.exec(text);
      if (match !== null) hits.push(`${route}: ${match[0]}`);
    }
  }
  assert.deepEqual(hits, [], "Move Worker internals to contributor material on GitHub.");
});

test("serves the Rondyr favicon from docs/brand/", () => {
  assert.equal(
    built("favicon.svg"),
    readFileSync(repositoryPath("docs/brand/rondyr-favicon.svg"), "utf8"),
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

test("the landing page has the Deploy to Cloudflare button, brand marks, prompt, and first run", () => {
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
  assert.match(text, /copy this prompt for your agent/iu);
  assert.match(text, /TypeSafe AI/u);
  assert.match(text, /OpenAI/u);
  assert.match(text, /Cloudflare/u);
  assert.ok(hrefs(tree).includes("https://x.com/_philDL"));
  assert.ok(hrefs(tree).includes("https://basaltbytes.com"));
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

test("the landing page shows every step of the message lifecycle at its end", () => {
  const tree = builtPage("/");
  const stages = elements(tree, (node) => node.properties["dataStage"] !== undefined);
  assert.deepEqual(
    stages.map((stage) => stage.properties["dataStage"]),
    lifecycleSteps.map((step) => step.id),
  );
  const texts = stages.map((stage) => toString(stage).replaceAll(/\s+/gu, " "));
  const [create, connect, submit, reception, analysis, outcome] = texts;
  for (const [index, step] of lifecycleSteps.entries()) {
    for (const caption of captionsOf(step)) {
      assert.ok(texts[index]?.includes(caption.title), step.id);
      assert.ok(texts[index]?.includes(caption.text), step.id);
    }
  }
  // Without the page's script a step is not played: its window has to show the result.
  assert.match(create ?? "", /Forms\s*\/\s*New form\s*Contact/u);
  assert.ok(create?.includes(story.form.business));
  assert.ok(create?.includes(story.address));
  assert.ok(connect?.includes(`action="${story.address}"`));
  assert.ok(connect?.includes('method="post"'));
  for (const message of messages) {
    assert.ok(submit?.includes(message.text), message.id);
    assert.ok(reception?.includes(message.sender.email), message.id);
    assert.ok(outcome?.includes(message.text), message.id);
  }
  assert.match(reception ?? "", /Origin\s*allowed/u);
  assert.match(reception ?? "", /Turnstile\s*verified/u);
  assert.match(analysis ?? "", /Sales outreach\s*93%/u);
  assert.ok(analysis?.includes("Probable sales outreach (93%). Goes to review above 50%."));
  assert.match(analysis ?? "", /Sales outreach\s*3%/u);
  assert.ok(analysis?.includes("Accepted automatically by Jev. No check sent it to review."));
  assert.match(outcome ?? "", /To review\s*0\s*1/u);
  assert.ok(outcome?.includes("Accept and send"));
  assert.match(outcome ?? "", /Accepted\s*0\s*1/u);
  assert.match(
    outcome ?? "",
    new RegExp(`Email to ${story.destinations.email}\\s*Sending\\s*Delivered`, "u"),
  );

  // What depends on the message is there for each message from the step that sends it, and
  // without the script only the first message is shown.
  const [shown] = messages;
  for (const stage of stages.slice(2)) {
    const root: Root = { type: "root", children: [stage] };
    const written = elements(root, (node) => node.properties["dataMessage"] !== undefined);
    for (const message of messages) {
      assert.ok(
        written.some((node) => node.properties["dataMessage"] === message.id),
        `${String(stage.properties["dataStage"])} for ${message.id}`,
      );
    }
    for (const node of written) {
      assert.equal(node.properties["hidden"] === true, node.properties["dataMessage"] !== shown.id);
    }
  }

  // Each step has a window, and a control in a window that plays it again. Without the
  // script no control works, so each one is disabled; the start of a step is inert.
  for (const stage of stages) {
    const root: Root = { type: "root", children: [stage] };
    const [figure, ...others] = elements(root, (node) => node.tagName === "figure");
    assert.equal(others.length, 0);
    assert.ok(String(figure?.properties["ariaLabel"]).length > 10);
    for (const start of elements(root, (node) => node.properties["dataAlt"] === "a")) {
      assert.equal(start.properties["inert"], true);
    }
  }
  const controls = elements(tree, (node) => node.properties["dataControl"] !== undefined);
  for (const control of controls) {
    assert.equal(control.tagName, "button");
    assert.equal(control.properties["disabled"], true);
    assert.ok(
      toString(control).trim() !== "" || control.properties["ariaLabel"] !== undefined,
      "a control has a name",
    );
  }
  const played = new Set(
    stages.flatMap((stage) =>
      elements({ type: "root", children: [stage] }, (node) => node.tagName === "button").map(
        (control) => control.properties["dataControl"] || stage.properties["dataStage"],
      ),
    ),
  );
  assert.deepEqual([...played].toSorted(), lifecycleSteps.map((step) => step.id).toSorted());

  // The excerpts of the dashboard take its palette, light and dark.
  const page = built("index.html");
  assert.match(page, /\.rondyr-ui\{--ui-background:oklch\(/u);
  assert.match(page, /:root\[data-theme="dark"\] \.rondyr-ui\{--ui-background:oklch\(/u);
});

test("ships robots.txt, llms.txt, llms-full.txt, per-page .md mirrors, og-image.png, and _headers", () => {
  const robots = built("robots.txt");
  assert.match(
    robots,
    /^User-agent: \*\nContent-Signal: search=yes, ai-input=yes, ai-train=yes\nAllow: \/\n/u,
  );
  assert.ok(robots.includes("User-agent: OAI-SearchBot\nAllow: /\n"));
  assert.ok(robots.includes("User-agent: Claude-SearchBot\nAllow: /\n"));
  assert.ok(robots.includes("User-agent: Google-Extended\nAllow: /\n"));
  assert.ok(robots.includes("User-agent: PerplexityBot\nAllow: /\n"));
  assert.match(robots, /Sitemap: https?:\/\/[^\s]+\/sitemap-index\.xml\n$/u);

  const llms = built("llms.txt");
  const llmsFull = built("llms-full.txt");
  const indexMd = built("index.md");
  assert.ok(indexMd.includes("## Rondyr vs. hosted form backends"));
  for (const document of documents) {
    const mdPath = `${document.id}.md`;
    assert.ok(llms.includes(`/${mdPath}`), document.path);
    assert.ok(llmsFull.includes(`Canonical URL:`), document.path);
    assert.ok(built(mdPath).startsWith(`# ${readDocument(document).title}\n`), document.path);
  }

  assert.ok(readFileSync(new URL("og-image.png", dist)).byteLength > 10_000);
  const headers = built("_headers");
  assert.match(headers, /\/_astro\/\*/u);
  assert.match(headers, /Content-Signal: search=yes, ai-input=yes, ai-train=yes/u);
  assert.match(headers, /Link: <\/llms\.txt>; rel="alternate"; type="text\/markdown"/u);
  assert.match(headers, /\/\*\.md\n[\s\S]*X-Robots-Tag: noindex/u);
  assert.match(headers, /\/404\.html\n\s+X-Robots-Tag: noindex/u);
});

test("adds OpenGraph images, Twitter cards, markdown alternates, and JSON-LD to every page and marks 404 noindex", () => {
  const home = builtPage("/");
  const homeOgType = elements(
    home,
    (node) => node.tagName === "meta" && node.properties["property"] === "og:type",
  );
  assert.equal(homeOgType[0]?.properties["content"], "website");

  const homeScripts = elements(
    home,
    (node) => node.tagName === "script" && node.properties["type"] === "application/ld+json",
  );
  assert.equal(homeScripts.length, 1);
  const homeGraph: { "@graph": { "@type": string | string[] }[] } = JSON.parse(
    toString(homeScripts[0]!),
  );
  assert.deepEqual(
    homeGraph["@graph"].map((node) => node["@type"]),
    ["Organization", "WebSite", ["SoftwareApplication", "SoftwareSourceCode"], "FAQPage"],
  );

  for (const route of ["/", ...documents.map(({ id }) => pageRoute(id))]) {
    const tree = builtPage(route);
    const ogImage = elements(
      tree,
      (node) => node.tagName === "meta" && node.properties["property"] === "og:image",
    );
    const twitterImage = elements(
      tree,
      (node) => node.tagName === "meta" && node.properties["name"] === "twitter:image",
    );
    assert.match(String(ogImage[0]?.properties["content"]), /\/og-image\.png$/u, route);
    assert.match(String(twitterImage[0]?.properties["content"]), /\/og-image\.png$/u, route);
    const alternates = elements(
      tree,
      (node) =>
        node.tagName === "link" &&
        Array.isArray(node.properties["rel"]) &&
        node.properties["rel"].includes("alternate") &&
        node.properties["type"] === "text/markdown",
    ).map((node) => String(node.properties["href"]));
    assert.ok(alternates.includes("/llms.txt"), route);
    assert.ok(alternates.includes(route === "/" ? "/index.md" : `${route.slice(0, -1)}.md`), route);
    const jsonLd = elements(
      tree,
      (node) => node.tagName === "script" && node.properties["type"] === "application/ld+json",
    );
    assert.equal(jsonLd.length, 1, route);
    assert.doesNotThrow(() => JSON.parse(toString(jsonLd[0]!)), route);
  }

  const notFound = fromHtml(built("404.html"));
  const robots = elements(
    notFound,
    (node) => node.tagName === "meta" && node.properties["name"] === "robots",
  );
  assert.equal(robots[0]?.properties["content"], "noindex, follow");
  const canonical = elements(
    notFound,
    (node) =>
      node.tagName === "link" &&
      Array.isArray(node.properties["rel"]) &&
      node.properties["rel"].includes("canonical"),
  );
  assert.equal(canonical.length, 0);
});
