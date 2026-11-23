# Rondyr

Rondyr is a self-hosted form backend on Cloudflare. Read [architecture.md](architecture.md) before changing public contracts, the data model or the processing of submissions. The README describes what the repository can already run, and [docs/deployment.md](docs/deployment.md) describes deployment.

## Code

- Keep a single application Worker. The domain stays independent of Cloudflare, Drizzle and Alchemy. Ports declare the Effect services. Adapters provide the layers.
- The repository is a pnpm workspace. `apps/rondyr/` is the Worker and its dashboard (package `rondyr`). `packages/emdash-plugin/` is the EmDash plugin, MIT-licensed because sites compile it into their own Worker: the Worker imports nothing from it, and it copies no AGPL code from `apps/rondyr/src/`. `tooling/` holds the Oxlint rules and the shared TypeScript settings. The root package only delegates its scripts, so `pnpm check`, `pnpm dev` or `pnpm run deploy` work from the root and cover every package; a merge that changes only the plugin or the documentation deploys nothing.
- Every dependency version lives in the `catalog:` of `pnpm-workspace.yaml`, and the manifests say `catalog:`. The exception is the `dependencies` and `peerDependencies` of `packages/emdash-plugin`, which sites install from outside the workspace: they keep real ranges.
- Use Effect 4 and Effect Schema for business logic, errors and data boundaries. Compose the layers at the Worker's entry point. Keep files in kebab-case, except where a tool's convention or a generated file says otherwise.
- Migrations belong to development tooling and to deployment. Version Drizzle migrations and snapshots in `apps/rondyr/database/migrations`.
- For intake, a `202` response means the submission and its outbox event were persisted atomically. Consumers must tolerate duplicated events.
- Write everything in English: code, comments, commit messages, the README, `docs/`, `architecture.md`, issues, and pull request titles and descriptions. Older issues are still in French; do not add French text to them.
- Write in English first everything a user of the product reads: dashboard text, the confirmation page, emails, script prompts. The dashboard, the confirmation page and the emails also exist in French: a dashboard text is an i18next key present in `apps/rondyr/src/dashboard/locales/en` and `apps/rondyr/src/dashboard/locales/fr`, never a string in a component.

## Working on an issue

The GitHub issues are the roadmap. There are few of them and each one is large: an issue is delivered whole, in one pull request.

- One issue per branch and per PR. Write `Closes #n` only if every acceptance criterion is met; otherwise `Refs #n` and the list of what is missing.
- What turns out to be missing or weak along the way is fixed in the same PR. Do not open a follow-up issue and do not leave a "known limitation" note for something within reach.
- Do not push to `main` and do not deploy: a push to `main` deploys production and applies the D1 migrations.
- One Drizzle migration per issue, generated at the end with `pnpm db:generate --name …`. Read the SQL. Never rebuild `forms` or `submissions`: on D1, dropping the table would delete the rows of the linked tables in cascade. Another branch may carry a migration at the same time; yours is regenerated on top of `main` when the PR merges.
- A real message is never lost on purpose. When in doubt, the message is stored and quarantined with a reason; a refusal is allowed only where the issue decides it.
- The content of a message stays in `submissions.fields`. It goes neither into logs, nor into domain events, nor into an error summary.
- Routes and jobs import ports only. Runtime queries are prepared SQL, decoded by Effect Schema.
- A new setting or secret is optional at deployment: without it, the deployment succeeds and the feature concerned answers with a clear error.
- Both classifiers stay available through `RONDYR_CLASSIFIER`. Any change to a rule or to the classifier's input is measured with `pnpm evaluate` before and after, and increments `rulesVersion`.
- Integration tests run in workerd against the built Worker, without module mocks. External services are simulated in `apps/rondyr/vitest.config.ts` (Workers AI, webhook recipient, Resend, Siteverify). Never weaken an existing assertion and never disable a lint rule.
- The final report says what is done for each criterion, the exact results of `pnpm check` and `pnpm deploy:dry`, the decisions the issue did not settle, and what was not verified.

## Local skills

- [effect-ts](.agents/skills/effect-ts/SKILL.md) for Effect code and its tests.
- [coding-guidelines](.agents/skills/coding-guidelines/SKILL.md) for domain rules and code review.
- [rondyr-cloudflare](.agents/skills/rondyr-cloudflare/SKILL.md) for Alchemy, Worker bindings, D1 and workerd.
- [react-app-structure](.agents/skills/react-app-structure/SKILL.md) for the code in `apps/rondyr/src/dashboard`.
- [anti-slop-writing](.agents/skills/anti-slop-writing/SKILL.md) for documentation and interface text.

## Verification

Run `pnpm check` before a PR. Also run `pnpm deploy:dry` if the change touches the Worker, the assets or the platform configuration. CI checks both commands. The root `wrangler.json` is the deployment definition: the Deploy to Cloudflare button and `pnpm run deploy` (Wrangler, through Workers Builds) read it, and every tool of `apps/rondyr/` reads it through `worker-config.ts`. Alchemy is the second supported deployment path (`pnpm run deploy:alchemy`, on an explicit stage and the authorized profile), and the one that deploys the Basaltbytes instance; `pnpm doctor` fails when its definition drifts from `wrangler.json`.
