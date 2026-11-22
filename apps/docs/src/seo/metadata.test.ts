import assert from "node:assert/strict";
import { test } from "node:test";

import { faqItems, landingMeta } from "../landing.ts";
import { aiCrawlers, renderRobotsTxt } from "../pages/robots.txt.ts";
import { applySeoHead, ogImagePath, seoTitles } from "./metadata.ts";

import type { HeadEntry } from "./metadata.ts";

function findMeta(
  head: readonly HeadEntry[],
  attr: "name" | "property",
  key: string,
): string | undefined {
  const match = head.find((entry) => entry.tag === "meta" && entry.attrs?.[attr] === key);
  const content = match?.attrs?.["content"];
  if (content === undefined || content === true || content === false) return undefined;
  return content;
}

test("formats robots.txt with Content-Signal, AI crawler rules, and absolute sitemap URL", () => {
  const robots = renderRobotsTxt("https://rondyr.com/");
  assert.match(
    robots,
    /^User-agent: \*\nContent-Signal: search=yes, ai-input=yes, ai-train=yes\nAllow: \/\n/u,
  );
  for (const crawler of aiCrawlers) {
    assert.ok(robots.includes(`User-agent: ${crawler}\nAllow: /\n`), crawler);
  }
  assert.ok(robots.includes("https://rondyr.com/llms.txt"));
  assert.match(robots, /Sitemap: https:\/\/rondyr\.com\/sitemap-index\.xml\n$/u);
});

test("enriches the homepage with website OpenGraph, Twitter card, markdown alternates, and JSON-LD", () => {
  const head: HeadEntry[] = [
    { tag: "title", content: "Rondyr" },
    { tag: "meta", attrs: { property: "og:title", content: "Rondyr" } },
    { tag: "meta", attrs: { property: "og:type", content: "article" } },
    { tag: "meta", attrs: { name: "description", content: landingMeta.description } },
  ];

  applySeoHead(head, {
    origin: "https://rondyr.com",
    pathname: "/",
    pageId: "",
    pageTitle: "Rondyr",
    is404: false,
    isHome: true,
  });

  assert.equal(head.find((entry) => entry.tag === "title")?.content, landingMeta.title);
  assert.equal(findMeta(head, "property", "og:type"), "website");
  assert.equal(findMeta(head, "property", "og:title"), landingMeta.title);
  assert.equal(findMeta(head, "property", "og:image"), `https://rondyr.com${ogImagePath}`);
  assert.equal(findMeta(head, "name", "twitter:image"), `https://rondyr.com${ogImagePath}`);
  assert.equal(findMeta(head, "name", "twitter:creator"), "@_philDL");

  const markdownAlternates = head
    .filter(
      (entry) =>
        entry.tag === "link" &&
        entry.attrs?.["rel"] === "alternate" &&
        entry.attrs?.["type"] === "text/markdown",
    )
    .map((entry) => entry.attrs?.["href"]);
  assert.deepEqual(markdownAlternates, ["/index.md", "/llms.txt"]);

  const jsonLdTag = head.find(
    (entry) => entry.tag === "script" && entry.attrs?.["type"] === "application/ld+json",
  );
  assert.ok(jsonLdTag?.content !== undefined);
  const parsed: { "@graph": { "@type": string | string[]; mainEntity?: { name: string }[] }[] } =
    JSON.parse(jsonLdTag.content);
  const types = parsed["@graph"].map((node) => node["@type"]);
  assert.deepEqual(types, [
    "Organization",
    "WebSite",
    ["SoftwareApplication", "SoftwareSourceCode"],
    "FAQPage",
  ]);
  const faq = parsed["@graph"].find((node) => node["@type"] === "FAQPage");
  assert.equal(faq?.mainEntity?.length, faqItems.length);
});

test("enriches documentation pages with search titles, TechArticle, and BreadcrumbList", () => {
  const head: HeadEntry[] = [
    { tag: "title", content: "Fight spam | Rondyr" },
    {
      tag: "meta",
      attrs: { name: "description", content: "Filter form spam with classifier models." },
    },
  ];

  applySeoHead(head, {
    origin: "https://rondyr.com",
    pathname: "/spam-protection/",
    pageId: "spam-protection",
    pageTitle: "Fight spam",
    is404: false,
    isHome: false,
  });

  assert.equal(
    head.find((entry) => entry.tag === "title")?.content,
    seoTitles.get("spam-protection"),
  );
  assert.equal(findMeta(head, "property", "og:type"), "article");
  assert.equal(findMeta(head, "property", "og:title"), seoTitles.get("spam-protection"));

  const jsonLdTag = head.find(
    (entry) => entry.tag === "script" && entry.attrs?.["type"] === "application/ld+json",
  );
  assert.ok(jsonLdTag?.content !== undefined);
  const parsed: { "@graph": { "@type": string }[] } = JSON.parse(jsonLdTag.content);
  assert.deepEqual(
    parsed["@graph"].map((node) => node["@type"]),
    ["Organization", "WebSite", "TechArticle", "BreadcrumbList"],
  );
});

test("marks the 404 page noindex and removes its canonical link", () => {
  const head: HeadEntry[] = [
    { tag: "link", attrs: { rel: "canonical", href: "https://rondyr.com/404/" } },
    { tag: "meta", attrs: { property: "og:url", content: "https://rondyr.com/404/" } },
  ];

  applySeoHead(head, {
    origin: "https://rondyr.com",
    pathname: "/404",
    pageId: "404",
    pageTitle: "404",
    is404: true,
    isHome: false,
  });

  assert.equal(findMeta(head, "name", "robots"), "noindex, follow");
  assert.equal(
    head.some((entry) => entry.tag === "link" && entry.attrs?.["rel"] === "canonical"),
    false,
  );
  assert.equal(
    head.some((entry) => entry.tag === "meta" && entry.attrs?.["property"] === "og:url"),
    false,
  );
});
