// The navigation of the site. Each page is one line: `{ slug: "email" }` for
// `docs/email.md`. Its label is the page title, unless the line sets `label`.
// A Markdown file under docs/ that is not listed here fails the build.
import type { DocumentSource } from "./repository/documents.ts";

export interface SidebarPage {
  readonly slug: string;
  readonly label?: string;
}

export interface SidebarGroup {
  readonly label: string;
  readonly items: readonly SidebarPage[];
}

export const sidebar: readonly SidebarGroup[] = [
  {
    label: "Get started",
    items: [{ slug: "deployment" }, { slug: "concepts" }, { slug: "local-development" }],
  },
  {
    label: "Forms and the HTTP API",
    items: [{ slug: "forms" }, { slug: "api" }],
  },
  {
    label: "Spam classification",
    items: [{ slug: "evaluation" }],
  },
  {
    label: "Destinations",
    items: [{ slug: "webhooks" }, { slug: "email" }],
  },
  {
    label: "Integrations",
    items: [{ slug: "emdash" }],
  },
  {
    label: "Operations",
    items: [{ slug: "operations" }, { slug: "inbox" }],
  },
  {
    label: "Architecture",
    items: [{ slug: "architecture", label: "Technical architecture" }],
  },
];

/**
 * The problems between the navigation and the pages: a page missing from the navigation,
 * a navigation line without a page, or a page listed twice.
 */
export function sidebarProblems(documents: readonly DocumentSource[]): string[] {
  const listed = sidebar.flatMap(({ items }) => items.map(({ slug }) => slug));
  const ids = new Set(documents.map(({ id }) => id));
  const problems: string[] = [];
  for (const { path, id } of documents) {
    if (!listed.includes(id)) {
      problems.push(
        `${path} is not in the navigation: add { slug: "${id}" } to a group in apps/docs/src/sidebar.ts.`,
      );
    }
  }
  for (const [index, slug] of listed.entries()) {
    if (!ids.has(slug)) {
      problems.push(`apps/docs/src/sidebar.ts lists "${slug}", which is not a page.`);
    }
    if (listed.indexOf(slug) !== index) {
      problems.push(`apps/docs/src/sidebar.ts lists "${slug}" more than once.`);
    }
  }
  return problems;
}
