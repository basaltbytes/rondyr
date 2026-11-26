# Rondyr

Rondyr is a self-hosted form backend on Cloudflare. The code and its tests are the source of truth for the design: no separate architecture document is kept. The README describes what the repository can already run, and [docs/deployment.md](docs/deployment.md) describes deployment.

## Code

- Keep a single application Worker. The domain stays independent of Cloudflare, Drizzle and Alchemy. Ports declare the Effect services. Adapters provide the layers.
- The repository is a pnpm workspace. `apps/rondyr/` is the Worker and its dashboard (package `rondyr`), whose source is in `src/`: `domain/`, which imports neither of the two others; `worker/`, which runs in workerd; and `dashboard/`, which runs in the browser, reaches the domain through the `@rondyr/*` aliases and reaches the Worker through HTTP. `packages/emdash-plugin/` is the EmDash plugin, MIT-licensed because sites compile it into their own Worker: the Worker imports nothing from it, and it copies no AGPL code from `apps/rondyr/src/`. `tooling/` holds the Oxlint rules and the shared TypeScript settings. The root package only delegates its scripts, so `pnpm check`, `pnpm dev` or `pnpm run deploy` work from the root and cover every package; a merge that changes only the plugin or the documentation deploys nothing.
- Every dependency version lives in the `catalog:` of `pnpm-workspace.yaml`, and the manifests say `catalog:`. The exception is the `dependencies` and `peerDependencies` of `packages/emdash-plugin`, which sites install from outside the workspace: they keep real ranges.
- Use Effect 4 and Effect Schema for business logic, errors and data boundaries. Compose the layers at the Worker's entry point. Keep files in kebab-case, except where a tool's convention or a generated file says otherwise.
- Migrations belong to development tooling and to deployment. Version Drizzle migrations and snapshots in `apps/rondyr/database/migrations`.
- For intake, a `202` response means the submission and its outbox event were persisted atomically. Consumers must tolerate duplicated events.
- Write everything in English: code, comments, commit messages, the README, `docs/`, issues, and pull request titles and descriptions. Older issues are still in French; do not add French text to them.
- Write in English first everything a user of the product reads: dashboard text, the confirmation page, emails, script prompts. The dashboard, the confirmation page and the emails also exist in French: a dashboard text is an i18next key present in `apps/rondyr/src/dashboard/locales/en` and `apps/rondyr/src/dashboard/locales/fr`, never a string in a component.

## Where things are

- A Worker feature is one name in four places under `apps/rondyr/src/worker/`: `ports/<name>.ts`, `adapters/<kind>/`, `http/<name>-routes.ts` with its `*.integration.test.ts` beside it, and `jobs/`. The Drizzle schema is `adapters/database/database-schema.ts`. `worker.ts` is the entry point and `worker-implementation.ts` composes the layers.
- The classifier rules and `rulesVersion` are in `apps/rondyr/src/domain/submissions/classification.ts`, the Workers AI adapter is in `apps/rondyr/src/worker/adapters/ai/`, and `pnpm evaluate` runs `apps/rondyr/evals/`.
- In `apps/rondyr/src/dashboard/`: `features/<area>/` holds the screens, `lib/api/<resource>.ts` the HTTP clients, `components/ui/` the shadcn components, `locales/{en,fr}/translation.json` the texts, and `dashboard.css` the theme. Routes are files under `routes/_signed-in/o/$organizationId/`; quote the `$` in shell commands. `route-tree.gen.ts` is generated.
- Test support: `apps/rondyr/tests/integration/` holds the fixtures and `external-workers.ts`, the simulated services. `apps/rondyr/tests/e2e/fixtures.mjs` and `dashboard.spec.mjs` are the Playwright suite.
- The application's scripts (`doctor`, `smoke`, `screenshots`) are in `apps/rondyr/scripts/`. The release and deployment-scope scripts are in the root `scripts/`. The shared TypeScript settings are `tooling/tsconfig/base.json`.
- Read a dependency's source through `apps/rondyr/node_modules/<package>/src` (`effect`, `alchemy`, `@alchemy.run/cloudflare`, `@tanstack/react-router`). The root `node_modules` holds only the root package's tools, and `node_modules/.pnpm` can hold several versions of one package. A package that `apps/rondyr` does not declare sits beside the one that needs it: `apps/rondyr/node_modules/@tanstack/react-query/../query-core`. Effect's HTTP modules are in `effect/src/http/`, and the package ships its own `AGENTS.md` and `ai-docs/`.
- A new worktree has no `node_modules`, no `apps/rondyr/.env` and no `worker-configuration.d.ts`. Run `pnpm install`; `pnpm typecheck` generates the types, and [docs/local-development.md](docs/local-development.md) says how to write the `.env`.

## Working on an issue

The GitHub issues are the roadmap. There are few of them and each one is large: an issue is delivered whole, in one pull request.

- A PR does not need an issue. When it delivers one: one issue per branch and per PR. Write `Closes #n` only if every acceptance criterion is met; otherwise `Refs #n` and the list of what is missing.
- What turns out to be missing or weak along the way is fixed in the same PR. Do not open a follow-up issue and do not leave a "known limitation" note for something within reach.
- Do not push to `main` and do not deploy: a push to `main` deploys production and applies the D1 migrations.
- One Drizzle migration per issue, generated at the end with `pnpm db:generate --name …`. Read the SQL. Never rebuild `forms` or `submissions`: on D1, dropping the table would delete the rows of the linked tables in cascade. Another branch may carry a migration at the same time; yours is regenerated on top of `main` when the PR merges.
- A real message is never lost on purpose. When in doubt, the message is stored and quarantined with a reason; a refusal is allowed only where the issue decides it.
- The content of a message stays in `submissions.fields`. It goes neither into logs, nor into domain events, nor into an error summary.
- Routes and jobs import ports only. Runtime queries are prepared SQL, decoded by Effect Schema.
- A new setting or secret is optional at deployment: without it, the deployment succeeds and the feature concerned answers with a clear error.
- Both classifiers stay available through `RONDYR_CLASSIFIER`. Any change to a rule or to the classifier's input is measured with `pnpm evaluate` before and after, and increments `rulesVersion`.
- Integration tests run in workerd against the built Worker, without module mocks. External services are simulated in `apps/rondyr/vitest.config.ts` (Workers AI, webhook recipient, Resend, Siteverify). Never weaken an existing assertion and never disable a lint rule.
- Add a changeset file in `.changeset/` (via `pnpm changeset`, or written directly as `.changeset/<kebab-name>.md` with YAML frontmatter naming `"rondyr"` and/or `"@basaltbytes/emdash-plugin-rondyr"` as `patch`, `minor`, or `major`) for every user-facing change to either package. Docs-only, test-only, and internal tooling PRs do not need a changeset. Do not bump package versions or edit `CHANGELOG.md` by hand; the **Release** workflow opens the **Version Packages** PR and publishes GitHub Releases (`vX.Y.Z` for `rondyr`, `@basaltbytes/emdash-plugin-rondyr@X.Y.Z` for the plugin).
- The final report says what is done for each criterion, the exact results of `pnpm check` and `pnpm deploy:dry`, the decisions the issue did not settle, and what was not verified.

## Local skills

- [effect-ts](.agents/skills/effect-ts/SKILL.md) for Effect code and its tests.
- [coding-guidelines](.agents/skills/coding-guidelines/SKILL.md) for domain rules and code review.
- [rondyr-cloudflare](.agents/skills/rondyr-cloudflare/SKILL.md) for Alchemy, Worker bindings, D1 and workerd.
- [react-app-structure](.agents/skills/react-app-structure/SKILL.md) for the code in `apps/rondyr/src/dashboard`.
- [anti-slop-writing](.agents/skills/anti-slop-writing/SKILL.md) for documentation and interface text.

## Verification

Run `pnpm check` before a PR. Also run `pnpm deploy:dry` if the change touches the Worker, the assets or the platform configuration. CI checks both commands. The root `wrangler.json` is the deployment definition: the Deploy to Cloudflare button and `pnpm run deploy` (Wrangler, through Workers Builds) read it, and every tool of `apps/rondyr/` reads it through `worker-config.ts`. Alchemy is the second supported deployment path (`pnpm run deploy:alchemy`, on an explicit stage and the authorized profile), and the one that deploys the Basaltbytes instance; `pnpm doctor` fails when its definition drifts from `wrangler.json`.
