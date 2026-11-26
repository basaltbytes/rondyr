// SEO metadata, OpenGraph/Twitter tags, and JSON-LD structured data for every page.
import { deployUrl, faqItems, landingMeta } from "../landing.ts";
import { githubRepository } from "../repository/documents.ts";

/** Site name used in titles, OpenGraph, and structured data. */
export const siteName = "Rondyr";

/** Maintainer organization name for structured data. */
export const authorName = "Basaltbytes";

/** Maintainer organization homepage. */
export const authorUrl = "https://basaltbytes.com";

/** Maintainer X handle for Twitter Card attribution. */
export const authorTwitter = "@_philDL";

/** Path of the 1200x630 OpenGraph and Twitter social card image. */
export const ogImagePath = "/og-image.png";

/** Width of the social card image in pixels. */
export const ogImageWidth = "1200";

/** Height of the social card image in pixels. */
export const ogImageHeight = "630";

/**
 * Search-focused `<title>` tags for documentation pages (kept under 60 characters).
 * Page `<h1>` headings and sidebar labels stay short and come from the Markdown files.
 */
export const seoTitles: ReadonlyMap<string, string> = new Map([
  ["deployment", "Deploy Rondyr to Cloudflare in One Click | Rondyr"],
  ["forms", "HTML & JSON Form Backend Setup | Rondyr"],
  ["spam-protection", "AI Spam Filtering, Honeypot & Turnstile | Rondyr"],
  ["inbox", "Submission Inbox, Quarantine & Exports | Rondyr"],
  ["email", "Form Email Notifications (Resend & Cloudflare) | Rondyr"],
  ["webhooks", "Signed Form Webhooks (HMAC-SHA-256) | Rondyr"],
  ["connectors", "Discord, Slack & Airtable Form Connectors | Rondyr"],
  ["emdash", "EmDash CMS Form Plugin Integration | Rondyr"],
  ["api", "Form Backend HTTP API Reference | Rondyr"],
  ["costs", "Self-Hosting Costs & Cloudflare Limits | Rondyr"],
  ["team", "Team Roles, Invitations & Access Control | Rondyr"],
  ["contributing", "Contributing & Open-Source License | Rondyr"],
]);

/** A single tag in Starlight's `head` array. */
export interface HeadEntry {
  tag: "title" | "base" | "link" | "style" | "meta" | "script" | "noscript" | "template";
  attrs?: Record<string, string | boolean | undefined> | undefined;
  content?: string | undefined;
}

export interface SeoHeadOptions {
  readonly origin: string;
  readonly pathname: string;
  readonly pageId: string;
  readonly pageTitle: string;
  readonly is404: boolean;
  readonly isHome: boolean;
}

interface JsonLdRef {
  readonly "@id": string;
}

interface OrganizationNode {
  readonly "@type": "Organization";
  readonly "@id": string;
  readonly name: string;
  readonly url: string;
  readonly sameAs: readonly string[];
}

interface WebSiteNode {
  readonly "@type": "WebSite";
  readonly "@id": string;
  readonly name: string;
  readonly url: string;
  readonly description: string;
  readonly inLanguage: string;
  readonly publisher: JsonLdRef;
}

interface SoftwareApplicationNode {
  readonly "@type": readonly ["SoftwareApplication", "SoftwareSourceCode"];
  readonly "@id": string;
  readonly name: string;
  readonly alternateName: string;
  readonly description: string;
  readonly url: string;
  readonly applicationCategory: string;
  readonly applicationSubCategory: string;
  readonly operatingSystem: string;
  readonly runtimePlatform: string;
  readonly programmingLanguage: string;
  readonly codeRepository: string;
  readonly installUrl: string;
  readonly softwareRequirements: string;
  readonly softwareHelp: {
    readonly "@type": "CreativeWork";
    readonly url: string;
  };
  readonly isAccessibleForFree: boolean;
  readonly license: string;
  readonly keywords: readonly string[];
  readonly offers: {
    readonly "@type": "Offer";
    readonly price: string;
    readonly priceCurrency: string;
  };
  readonly author: JsonLdRef;
  readonly image: string;
  readonly screenshot: string;
  readonly sameAs: readonly string[];
  readonly featureList: readonly string[];
}

interface FaqPageNode {
  readonly "@type": "FAQPage";
  readonly "@id": string;
  readonly mainEntity: readonly {
    readonly "@type": "Question";
    readonly name: string;
    readonly acceptedAnswer: {
      readonly "@type": "Answer";
      readonly text: string;
    };
  }[];
}

interface TechArticleNode {
  readonly "@type": "TechArticle";
  readonly "@id": string;
  readonly headline: string;
  readonly description: string;
  readonly url: string;
  readonly mainEntityOfPage: {
    readonly "@type": "WebPage";
    readonly "@id": string;
  };
  readonly inLanguage: string;
  readonly isPartOf: JsonLdRef;
  readonly author: JsonLdRef;
  readonly publisher: JsonLdRef;
  readonly image: string;
}

interface BreadcrumbListNode {
  readonly "@type": "BreadcrumbList";
  readonly "@id": string;
  readonly itemListElement: readonly {
    readonly "@type": "ListItem";
    readonly position: number;
    readonly name: string;
    readonly item: string;
  }[];
}

type JsonLdNode =
  | OrganizationNode
  | WebSiteNode
  | SoftwareApplicationNode
  | FaqPageNode
  | TechArticleNode
  | BreadcrumbListNode;

interface JsonLdGraph {
  readonly "@context": "https://schema.org";
  readonly "@graph": readonly JsonLdNode[];
}

/** Serializes JSON-LD safely for embedding inside a `<script>` element. */
function serializeJsonLd(graph: JsonLdGraph): string {
  return JSON.stringify(graph).replace(/</gu, "\\u003c");
}

function organizationEntity(origin: string): OrganizationNode {
  return {
    "@type": "Organization",
    "@id": `${origin}/#organization`,
    name: authorName,
    url: authorUrl,
    sameAs: ["https://github.com/basaltbytes", "https://x.com/_philDL"],
  };
}

function websiteEntity(origin: string): WebSiteNode {
  return {
    "@type": "WebSite",
    "@id": `${origin}/#website`,
    name: siteName,
    url: `${origin}/`,
    description: landingMeta.description,
    inLanguage: "en",
    publisher: { "@id": `${origin}/#organization` },
  };
}

/** Builds the homepage JSON-LD graph: Organization, WebSite, SoftwareApplication, and FAQPage. */
export function buildHomeJsonLd(origin: string): string {
  const cleanOrigin = origin.replace(/\/+$/u, "");
  const imageUrl = `${cleanOrigin}${ogImagePath}`;
  return serializeJsonLd({
    "@context": "https://schema.org",
    "@graph": [
      organizationEntity(cleanOrigin),
      websiteEntity(cleanOrigin),
      {
        "@type": ["SoftwareApplication", "SoftwareSourceCode"],
        "@id": `${cleanOrigin}/#software`,
        name: siteName,
        alternateName: "Rondyr Form Backend",
        description: landingMeta.description,
        url: `${cleanOrigin}/`,
        applicationCategory: "DeveloperApplication",
        applicationSubCategory: "Form Backend",
        operatingSystem: "Cloudflare Workers",
        runtimePlatform: "Cloudflare Workers",
        programmingLanguage: "TypeScript",
        codeRepository: githubRepository,
        installUrl: deployUrl,
        softwareRequirements:
          "Cloudflare Workers (Workers Free to test-drive; Workers Paid at $5/month per account for production)",
        softwareHelp: {
          "@type": "CreativeWork",
          url: `${cleanOrigin}/deployment/`,
        },
        isAccessibleForFree: true,
        license: "https://www.gnu.org/licenses/agpl-3.0.en.html",
        keywords: [
          "self-hosted form backend",
          "open-source form backend",
          "Cloudflare form backend",
          "Formspree alternative",
          "classifier-model spam filtering",
          "Jev",
          "OpenAI Decisions",
          "one-click deploy",
          "static site form backend",
          "contact form API",
        ],
        offers: {
          "@type": "Offer",
          price: "0",
          priceCurrency: "USD",
        },
        author: { "@id": `${cleanOrigin}/#organization` },
        image: imageUrl,
        screenshot: imageUrl,
        sameAs: [githubRepository],
        featureList: [
          "One-click deployment to your own Cloudflare account",
          "Classifier-model spam, sales-pitch, and business-relevance filtering with Jev or OpenAI Decisions",
          "Human-in-the-loop quarantine inbox so doubtful messages are never silently deleted",
          "Honeypot fields, Cloudflare Turnstile, allowed origins, rate limits, and repeat detection",
          "Email forwarding via Resend or Cloudflare Email Sending with recipient opt-in",
          "HMAC-SHA-256 signed webhooks with secret rotation and automatic retries",
          "Built-in Discord, Slack, and Airtable connectors",
          "EmDash CMS plugin and HTTP API with idempotency keys",
        ],
      },
      {
        "@type": "FAQPage",
        "@id": `${cleanOrigin}/#faq`,
        mainEntity: faqItems.map(({ question, answer }) => ({
          "@type": "Question",
          name: question,
          acceptedAnswer: {
            "@type": "Answer",
            text: answer,
          },
        })),
      },
    ],
  });
}

/** Builds the documentation page JSON-LD graph: TechArticle and BreadcrumbList. */
export function buildDocJsonLd(
  origin: string,
  canonicalUrl: string,
  headline: string,
  description: string,
): string {
  const cleanOrigin = origin.replace(/\/+$/u, "");
  return serializeJsonLd({
    "@context": "https://schema.org",
    "@graph": [
      organizationEntity(cleanOrigin),
      websiteEntity(cleanOrigin),
      {
        "@type": "TechArticle",
        "@id": `${canonicalUrl}#article`,
        headline,
        description,
        url: canonicalUrl,
        mainEntityOfPage: { "@type": "WebPage", "@id": canonicalUrl },
        inLanguage: "en",
        isPartOf: { "@id": `${cleanOrigin}/#website` },
        author: { "@id": `${cleanOrigin}/#organization` },
        publisher: { "@id": `${cleanOrigin}/#organization` },
        image: `${cleanOrigin}${ogImagePath}`,
      },
      {
        "@type": "BreadcrumbList",
        "@id": `${canonicalUrl}#breadcrumb`,
        itemListElement: [
          {
            "@type": "ListItem",
            position: 1,
            name: siteName,
            item: `${cleanOrigin}/`,
          },
          {
            "@type": "ListItem",
            position: 2,
            name: headline,
            item: canonicalUrl,
          },
        ],
      },
    ],
  });
}

function readMeta(head: readonly HeadEntry[], attr: "name" | "property", value: string): string {
  const match = head.find((entry) => entry.tag === "meta" && entry.attrs?.[attr] === value);
  const content = match?.attrs?.["content"];
  if (content === undefined || content === true || content === false) return "";
  return content;
}

function replaceTag(
  head: HeadEntry[],
  match: (entry: HeadEntry) => boolean,
  replacement: HeadEntry,
): void {
  const filtered = head.filter((entry) => !match(entry));
  head.length = 0;
  head.push(...filtered, replacement);
}

function removeTag(head: HeadEntry[], match: (entry: HeadEntry) => boolean): void {
  const filtered = head.filter((entry) => !match(entry));
  head.length = 0;
  head.push(...filtered);
}

function setMeta(head: HeadEntry[], attr: "name" | "property", key: string, content: string): void {
  replaceTag(head, (entry) => entry.tag === "meta" && entry.attrs?.[attr] === key, {
    tag: "meta",
    attrs: { [attr]: key, content },
  });
}

/**
 * Enriches Starlight's `head` array in place with OpenGraph images, Twitter cards,
 * search-optimized titles, theme colors, llms.txt discovery, 404 noindex, and JSON-LD.
 */
export function applySeoHead(head: HeadEntry[], options: SeoHeadOptions): void {
  const cleanOrigin = options.origin.replace(/\/+$/u, "");
  const imageUrl = `${cleanOrigin}${ogImagePath}`;

  if (options.is404) {
    removeTag(head, (entry) => entry.tag === "link" && entry.attrs?.["rel"] === "canonical");
    removeTag(head, (entry) => entry.tag === "meta" && entry.attrs?.["property"] === "og:url");
    setMeta(head, "name", "robots", "noindex, follow");
    return;
  }

  const customTitle = options.isHome ? landingMeta.title : seoTitles.get(options.pageId);
  const resolvedTitle =
    customTitle ??
    head.find((entry) => entry.tag === "title")?.content ??
    `${options.pageTitle} | ${siteName}`;

  if (customTitle !== undefined) {
    replaceTag(head, (entry) => entry.tag === "title", {
      tag: "title",
      content: customTitle,
    });
  }

  const description = readMeta(head, "name", "description") || landingMeta.description;
  const canonicalUrl = new URL(options.pathname, `${cleanOrigin}/`).href;

  setMeta(head, "property", "og:title", resolvedTitle);
  setMeta(head, "property", "og:type", options.isHome ? "website" : "article");
  setMeta(head, "property", "og:locale", "en_US");
  setMeta(head, "property", "og:description", description);
  setMeta(head, "property", "og:image", imageUrl);
  setMeta(head, "property", "og:image:type", "image/png");
  setMeta(head, "property", "og:image:width", ogImageWidth);
  setMeta(head, "property", "og:image:height", ogImageHeight);
  setMeta(head, "property", "og:image:alt", landingMeta.ogImageAlt);

  setMeta(head, "name", "twitter:card", "summary_large_image");
  setMeta(head, "name", "twitter:title", resolvedTitle);
  setMeta(head, "name", "twitter:description", description);
  setMeta(head, "name", "twitter:image", imageUrl);
  setMeta(head, "name", "twitter:image:alt", landingMeta.ogImageAlt);
  setMeta(head, "name", "twitter:creator", authorTwitter);

  removeTag(head, (entry) => entry.tag === "meta" && entry.attrs?.["name"] === "theme-color");
  head.push(
    {
      tag: "meta",
      attrs: {
        name: "theme-color",
        media: "(prefers-color-scheme: light)",
        content: "#f2f0e9",
      },
    },
    {
      tag: "meta",
      attrs: {
        name: "theme-color",
        media: "(prefers-color-scheme: dark)",
        content: "#1c2121",
      },
    },
  );

  const markdownHref = options.isHome ? "/index.md" : `/${options.pageId}.md`;
  removeTag(
    head,
    (entry) =>
      entry.tag === "link" &&
      entry.attrs?.["rel"] === "alternate" &&
      entry.attrs?.["type"] === "text/markdown",
  );
  head.push(
    {
      tag: "link",
      attrs: {
        rel: "alternate",
        type: "text/markdown",
        href: markdownHref,
        title: "Markdown version of this page",
      },
    },
    {
      tag: "link",
      attrs: {
        rel: "alternate",
        type: "text/markdown",
        href: "/llms.txt",
        title: "Rondyr documentation index for LLMs",
      },
    },
  );

  const jsonLd = options.isHome
    ? buildHomeJsonLd(cleanOrigin)
    : buildDocJsonLd(cleanOrigin, canonicalUrl, options.pageTitle, description);

  removeTag(
    head,
    (entry) => entry.tag === "script" && entry.attrs?.["type"] === "application/ld+json",
  );
  head.push({
    tag: "script",
    attrs: { type: "application/ld+json" },
    content: jsonLd,
  });
}
