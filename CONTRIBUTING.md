# Contributing

The roadmap is the list of [GitHub issues](https://github.com/basaltbytes/rondyr/issues); section 12 of [architecture.md](./architecture.md) gives the order they are worked in. Coding and writing rules are in [AGENTS.md](./AGENTS.md).

## Development

```sh
pnpm install --frozen-lockfile
pnpm check         # lint, format, types, tests in workerd, Knip, migrations
pnpm deploy:dry    # build, validate the bundle with Wrangler, check its size budget
```

Both commands must pass before you open a pull request; CI runs them again. The [README](./README.md#quick-start) covers the local setup, and it needs no Cloudflare account.

After a schema change in `src/adapters/database`, run `pnpm db:generate --name your-migration-name`, read the generated SQL, and commit the new folder in `database/migrations` with its snapshot.

## Dashboard browser tests

Install Chromium for Playwright after installing the project dependencies.

```sh
pnpm exec playwright install --only-shell chromium
pnpm test:e2e
```

On Linux, add `--with-deps` to the install command if Chromium needs system libraries. For an interactive run, install Chromium without `--only-shell` and pass `--headed` to `pnpm test:e2e`.

The suite builds the dashboard and Worker, applies the D1 migrations to a fresh local database for each test, and starts a second local site for cross-origin submissions. Workers AI, the webhook receiver, and Resend run as local fixtures. The suite needs no Cloudflare credentials, API keys, or running dev server.

CI runs the suite in the **Dashboard browser tests** job. To inspect a failed test's trace, run `pnpm exec playwright show-trace <path-to-trace.zip>` with the trace from `test-results/`.

## Pull requests

- Work on a branch. In the Basaltbytes repository, a push to `main` deploys production and applies the D1 migrations.
- Keep one issue per pull request, and reference it with `Closes #n` or `Refs #n`.
- Add tests for the behavior you change. Integration tests run in workerd against the built Worker and don't mock modules.
- Code and comments are in English, like the README and `docs/`. Issues, pull request descriptions, `architecture.md`, and the dashboard text are in French.

## License of contributions

Rondyr is licensed under the [GNU Affero General Public License v3.0](./LICENSE). By opening a pull request, you agree to license your contribution under the same terms.
