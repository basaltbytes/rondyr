# @rondyr/docs

The documentation site of Rondyr: a landing page and one page per Markdown file of the repository, built with [Astro Starlight](https://starlight.astro.build) and the Lucode theme, and served as static assets by a Cloudflare Worker.

## Pages

The pages are the Markdown files of the repository, read where they are: every `.md` file under `docs/`, and `architecture.md`. Nothing is copied into this package. `docs/email.md` becomes `/email/`, and `architecture.md` becomes `/architecture/`.

The files keep no frontmatter. A page takes its title from the file's first `#` heading, and its meta description from the file's first paragraph. A file without a first-level heading fails the build.

To add a page, write the file under `docs/`, then add its line to a group in `src/sidebar.ts`:

```ts
{ slug: "email" },
```

The label is the page title unless the line sets `label`. The build fails while a file under `docs/` is missing from `src/sidebar.ts`, and names the line to add.

The landing page is `src/pages/index.astro`, with its first screen in `src/components/landing-hero.astro` and its text in `src/landing.ts`. Its list of pages comes from `src/sidebar.ts`.

## Links

Links in the Markdown files are written for GitHub, and the build rewrites them for the site:

- A link to another page, such as `./webhooks.md#signature` or `../architecture.md`, goes to that page: `/webhooks/#signature`. When the link text is the file name, such as `deployment.md`, the site shows the page title instead.
- A link to any other file or folder of the repository, such as `./examples/verify-webhook.ts` or `../LICENSE`, goes to that file on GitHub, on the `main` branch.
- An image with a relative path is copied into the site with the page.

The build fails on a link to a file that does not exist, to a path outside the repository, or to a heading that a Markdown file outside the site doesn't have. After the build, `src/integrations/built-links.ts` reads every built page and fails the build when a link, image, stylesheet or script inside the site has no target, or when an anchor has no matching heading. That covers the Markdown pages, the landing page and the navigation.

The status block at the top of `architecture.md` has a `**Production:**` line with the address of the maintainers' instance. The site leaves that line out, and a test checks that the address appears in no built file.

## Commands

Run them from the repository root after `pnpm install --frozen-lockfile`.

```sh
pnpm --filter @rondyr/docs dev        # development server, reloads when a file under docs/ changes
pnpm --filter @rondyr/docs build      # writes the site to apps/docs/dist/
pnpm --filter @rondyr/docs preview    # serves dist/ at http://localhost:4321
pnpm --filter @rondyr/docs test       # unit tests, build, then tests of the built site
pnpm --filter @rondyr/docs typecheck
```

The root `pnpm check` runs the tests, the build and the type check with the other packages, and lints and formats this package. CI uploads the built site of each run as the `documentation-site` artifact.

`RONDYR_DOCS_URL` sets the address of the site, for canonical links and the sitemap. It is an origin, such as `https://docs.example.com`, with no path. Without it, the build uses `http://localhost:4321`.

## Deploy

The `Deploy docs` workflow builds the site and uploads it to the `rondyr-docs` Worker after a push to `main` that changes `apps/docs/`, `docs/`, `architecture.md`, the dependencies or the workflow. It needs:

| Setting | Kind | Value |
| --- | --- | --- |
| `RONDYR_DOCS_URL` | Variable | The address of the site, such as `https://docs.example.com`, or `https://rondyr-docs.<subdomain>.workers.dev` |
| `CLOUDFLARE_API_TOKEN` | Secret | The token of the Worker's deployment. It needs `Workers Scripts Write` on the account and, for a custom domain, `Zone Read` and `Workers Routes Write` on the domain's zone |
| `CLOUDFLARE_ACCOUNT_ID` | Secret | The account of the Worker |

Without `RONDYR_DOCS_URL`, the workflow skips the deployment with a notice. With a custom domain, the zone must be active in the same Cloudflare account; Wrangler attaches the domain to the Worker, and Cloudflare creates its DNS record and certificate. A `workers.dev` address needs a `workers.dev` subdomain on the account.

To deploy by hand, build for the address first, then upload:

```sh
export RONDYR_DOCS_URL=https://docs.example.com
pnpm --filter @rondyr/docs build
pnpm --filter @rondyr/docs exec wrangler login
pnpm --filter @rondyr/docs run deploy
```

`scripts/deploy.ts` refuses to upload a build made for another address. A change to the site never deploys the Rondyr Worker: `scripts/deploy-scope.mjs` counts `apps/docs/` and `docs/` as changes outside the Worker.

## Theme

`src/styles/theme.css` takes the colors from `docs/brand/rondyr.svg`. The header shows the wordmark from `docs/brand/`. The build writes a light and a dark copy of it to `.astro/brand/` with fixed colors, because Safari draws an SVG image with the system's color scheme even when the reader picks the other theme in the header. The favicon is `docs/brand/rondyr-mark.svg`, unchanged.

`patches/lucode-starlight@1.0.0.patch` is the patch of usine.dev's documentation: pagination links wrap on narrow screens, and the mobile menu shows the sidebar's groups with links 44 pixels high. A fenced `mermaid` block renders to SVG at build time with [Pele](https://pele.run/).
