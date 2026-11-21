# Contributing

The roadmap is the list of [GitHub issues](https://github.com/basaltbytes/rondyr/issues), and section 12 of [architecture.md](./architecture.md#12-order-of-work) records the order of work. Read [architecture.md](./architecture.md) before you change a public contract, the data model or the processing of submissions. Coding and writing rules are in [AGENTS.md](./AGENTS.md); they apply to people and to coding agents alike.

To report a vulnerability, don't open an issue: follow [SECURITY.md](./SECURITY.md).

## Development

```sh
pnpm install --frozen-lockfile
pnpm check         # lint, format, types, tests in workerd and Node, Knip, migrations, for every package
pnpm deploy:dry    # build, validate the bundle with Wrangler, check its size budget
```

Run them from the repository root: the root scripts run in each workspace package (`apps/rondyr`, `packages/emdash-plugin`, `tooling/*`). Both commands must pass before you open a pull request; CI runs them again. [docs/local-development.md](./docs/local-development.md) covers the local setup, which needs no Cloudflare account.

After a schema change in `apps/rondyr/src/adapters/database`, run `pnpm db:generate --name your-migration-name`, read the generated SQL, and commit the new folder in `apps/rondyr/database/migrations` with its snapshot.

A new dependency goes into the `catalog:` of `pnpm-workspace.yaml` with an exact version, and the package's manifest references it as `catalog:`. The `dependencies` and `peerDependencies` of `packages/emdash-plugin` are the exception: sites install the plugin from outside the workspace, so they keep real version ranges.

## Dashboard browser tests

Install Chromium for Playwright after installing the project dependencies.

```sh
pnpm --filter rondyr exec playwright install --only-shell chromium
pnpm test:e2e
```

On Linux, add `--with-deps` to the install command if Chromium needs system libraries. For an interactive run, install Chromium without `--only-shell` and pass `--headed` to `pnpm test:e2e`.

The suite builds the dashboard and Worker, applies the D1 migrations to a fresh local database for each test, and starts a second local site for cross-origin submissions. Workers AI, the webhook receiver, and Resend run as local fixtures. The suite needs no Cloudflare credentials, API keys, or running dev server.

CI runs the suite in the **Dashboard browser tests** job. To inspect a failed test's trace, run `pnpm --filter rondyr exec playwright show-trace <path-to-trace.zip>` with the trace from `apps/rondyr/test-results/`.

## Pull requests

- Work on a branch. In the Basaltbytes repository, a push to `main` deploys production and applies the D1 migrations.
- Keep one issue per pull request, and reference it with `Closes #n` when the pull request meets every acceptance criterion of the issue, or `Refs #n` with the list of what is missing.
- Add tests for the behavior you change. Integration tests run in workerd against the built Worker and don't mock modules.
- Write code, comments, commit messages, the README, `docs/`, `architecture.md`, issues, and pull request titles and descriptions in English. Some older issues are in French. The dashboard text, the confirmation page, and the emails are written in English first and also exist in French: a dashboard text is a key in both `apps/rondyr/dashboard/src/locales/en` and `apps/rondyr/dashboard/src/locales/fr`.

## License of contributions

Rondyr is licensed under the [GNU Affero General Public License v3.0](./LICENSE), and `packages/emdash-plugin` under the [MIT license](./packages/emdash-plugin/LICENSE). By opening a pull request, you agree to license your contribution under the license of the files you change.
