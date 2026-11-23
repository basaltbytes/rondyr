# Local development

You need Node.js 24.22 or later and pnpm 11. The local setup needs no Cloudflare account: Wrangler emulates D1, the queues, and the Durable Objects.

```sh
pnpm install --frozen-lockfile
cp apps/rondyr/.env.example apps/rondyr/.env
```

Generate two different values with `openssl rand -hex 32`, and set them as `BETTER_AUTH_SECRET` and `RONDYR_SETUP_TOKEN` in `apps/rondyr/.env`. To try webhooks or Turnstile, also set `RONDYR_SECRETS_KEY` to the output of `openssl rand -base64 32`. The default email provider, Resend, needs `RESEND_API_KEY` and `RONDYR_EMAIL_FROM` and sends real email. [Email setup](./email.md)

The dev server reads these values from `apps/rondyr/.env`, not from a `.env` or `.dev.vars` next to the root `wrangler.json`. Apply the migrations to the local database and start the Worker and the dashboard:

```sh
pnpm db:migrate
pnpm dev
```

If your checkout predates the root `wrangler.json`, run `pnpm db:migrate` once more after pulling: the local database has a new ID, so the dev server starts on an empty one.

Vite prints the local URL, usually `http://localhost:5173`. Public sign-up is closed. Open the URL: the page **Create the owner account** asks for the setup token from `apps/rondyr/.env`, then a name, an email address, and a password of 12 to 128 characters, creates the account and signs it in. The setup script does the same from a second terminal:

```sh
./apps/rondyr/scripts/setup-owner.sh http://localhost:5173
```

It asks for the same values and prints `First account created (HTTP 201).`. Rondyr refuses to create a second account even while the token is set, so you can leave it in `apps/rondyr/.env` or remove it. Other people join an organization through an invitation link from **Settings → Members**; see [Team and accounts](./team.md).

## First submission

In the dashboard, create an organization and a form, with an optional description of the business. Open the form from **Forms** in the sidebar to copy its submission address, then post to it:

```sh
curl --json '{"email":"visitor@example.com","message":"Is there room in the Saturday class?"}' \
  http://localhost:5173/f/YOUR_PUBLIC_ID
```

The queue consumer picks the message up a few seconds later. Locally there is no Workers AI binding, so every message is quarantined with the reason **Analysis unavailable**. Click **Refresh** in **To review** to see it; you can then open, accept, or archive it. [docs/forms.md](./forms.md) describes the form URL, its responses and its limits.

## Checks

The repository is a pnpm workspace. `apps/rondyr/` is the Worker and its dashboard, `packages/emdash-plugin/` the EmDash plugin, and `tooling/` the lint rules and the shared TypeScript settings. Dependency versions are in the catalog of `pnpm-workspace.yaml`. Run the commands from the root; they run in each package.

```sh
pnpm check         # lint, format, types, tests in workerd and Node, Knip, migrations, for every package
pnpm deploy:dry    # build, validate the bundle with Wrangler, check its size budget
```

CI runs both commands without Cloudflare credentials, and runs `pnpm test:e2e`, which ends with the dev-server check that `pnpm --filter rondyr test:dev` also runs. The check starts `pnpm dev` on a database of its own, creates the owner, posts a submission, and fails if the queue consumer leaves it `received`. The tests build the Worker first and run it in workerd with D1, the queues, and the Durable Objects emulated. The tests of the classifier evaluation harness in `apps/rondyr/evals/` run in Node; `pnpm evaluate --dry evals/corpus/synthetic.jsonl` runs it without credentials, and [docs/evaluation.md](./evaluation.md) covers real runs. [CONTRIBUTING.md](../CONTRIBUTING.md) covers the dashboard browser tests and pull requests.

After a schema change in `apps/rondyr/src/worker/adapters/database`, run `pnpm db:generate --name your-migration-name`, read the generated SQL, and commit the new folder in `apps/rondyr/database/migrations`. `pnpm dev:alchemy` runs the Alchemy stack locally with its own state and D1 database, as an alternative to `pnpm dev`.
