import { unified } from "@astrojs/markdown-remark";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import lucode from "lucode-starlight";

import { writeLogoVariants } from "./src/brand.ts";
import { builtLinks } from "./src/integrations/built-links.ts";
import { rehypeDiagrams } from "./src/markdown/rehype-diagrams.ts";
import { githubBranch, githubRepository, listDocuments } from "./src/repository/documents.ts";
import { remarkRepositoryLinks } from "./src/repository/links.ts";
import { remarkDropProductionLine } from "./src/repository/production-line.ts";
import { sidebar, sidebarProblems } from "./src/sidebar.ts";
import { siteUrl } from "./src/site-url.ts";

const problems = sidebarProblems(listDocuments());
if (problems.length > 0) throw new Error(problems.join("\n"));

const logo = writeLogoVariants(new URL("./.astro/brand/", import.meta.url));

export default defineConfig({
  site: siteUrl(process.env["RONDYR_DOCS_URL"]),
  trailingSlash: "always",
  markdown: {
    processor: unified({
      remarkPlugins: [remarkRepositoryLinks(), remarkDropProductionLine],
      rehypePlugins: [rehypeDiagrams],
    }),
    syntaxHighlight: { type: "shiki", excludeLangs: ["mermaid"] },
  },
  integrations: [
    starlight({
      title: "Rondyr",
      description:
        "Rondyr is a form backend with spam filtering that you deploy to your own Cloudflare account.",
      favicon: "/favicon.svg",
      editLink: { baseUrl: `${githubRepository}/edit/${githubBranch}/` },
      customCss: [
        "./src/styles/theme.css",
        "./src/styles/diagrams.css",
        "./src/styles/sidebar.css",
      ],
      logo: { light: logo.light, dark: logo.dark, alt: "Rondyr", replacesTitle: true },
      components: { Hero: "./src/components/landing-hero.astro" },
      plugins: [
        lucode({
          warnOverrides: false,
          navLinks: [
            { label: "Deploy", link: "/deployment/" },
            { label: "HTTP API", link: "/api/" },
            { label: "Architecture", link: "/architecture/" },
            { label: "GitHub", link: githubRepository },
          ],
          footerText: `Rondyr is licensed under AGPL-3.0. The source is on [GitHub](${githubRepository}).`,
        }),
      ],
      sidebar: sidebar.map(({ label, items }) => ({ label, items: [...items] })),
    }),
    builtLinks(),
  ],
});
