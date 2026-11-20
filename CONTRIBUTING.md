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

## Pull requests

- Work on a branch. In the Basaltbytes repository, a push to `main` deploys production and applies the D1 migrations.
- Keep one issue per pull request, and reference it with `Closes #n` or `Refs #n`.
- Add tests for the behavior you change. Integration tests run in workerd against the built Worker and don't mock modules.
- Code and comments are in English, like the README and `docs/`. Issues, pull request descriptions, `architecture.md`, and the dashboard text are in French.

## License of contributions

Rondyr is licensed under the [GNU Affero General Public License v3.0](./LICENSE). By opening a pull request, you agree to license your contribution under the same terms.
