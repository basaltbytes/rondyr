# Local development

You need Node.js 24.22 or later and pnpm 11. The local setup needs no Cloudflare account: Wrangler emulates D1, the queues, and the Durable Objects.

```sh
pnpm install --frozen-lockfile
cp apps/rondyr/.env.example apps/rondyr/.env
```

Generate two different values with `openssl rand -hex 32`, and set them as `RONDYR_SESSION_SECRET` and `RONDYR_SETUP_TOKEN` in `apps/rondyr/.env`. To try webhooks or Turnstile, also set `RONDYR_SECRETS_KEY` to the output of `openssl rand -base64 32`. The default email provider, Resend, needs `RESEND_API_KEY` and `RONDYR_EMAIL_FROM` and sends real email (and activates Email OTP sign-in). See [Email setup](./email.md).

The dev server reads these values from `apps/rondyr/.env`, not from a `.env` or `.dev.vars` next to the root `wrangler.json`. Apply the migrations to the local database and start the Worker and the dashboard:

```sh
pnpm db:migrate
pnpm dev
```

If your checkout predates the root `wrangler.json`, run `pnpm db:migrate` once more after pulling: the local database has a new ID, so the dev server starts on an empty one.

Vite prints the local URL, usually `http://localhost:5173`. Public sign-up is closed. Open the URL: **Create the owner account** asks for the setup token from `apps/rondyr/.env`, your name, and your email address, then prompts your browser to register a passkey and signs you in immediately. Rondyr refuses to create a second account even while the token is set, so you can leave it in `apps/rondyr/.env` or remove it. Other people join an organization through an invitation link from **Settings → Members**; see [Team and accounts](./team.md).

## Demo data

To look at the dashboard with sample data, start the dev server on a database of its own instead:

```sh
pnpm dev:demo
```

It needs no `apps/rondyr/.env`. The first run creates an owner account (`owner@example.test`), the organization **Atelier Terre**, two active forms and a suspended one, and eight messages: five to review, two accepted, and one archived. It writes a `RONDYR_RECOVERY_TOKEN` into `apps/rondyr/.wrangler/demo/.env` and prints the token and owner email. Open `/sign-in`, select **Recover access**, and register a browser passkey once to sign in. The database and its generated secrets stay in `apps/rondyr/.wrangler/demo`, so the next run finds the same data; delete that folder to start again. Pass a port after `--`, as in `pnpm dev:demo -- --port 4100`.

## First submission

In the dashboard, create an organization and a form, with an optional description of the business. Open the form from **Forms** in the sidebar to copy its submission address, then post to it:

```sh
curl --json '{"email":"visitor@example.com","message":"Is there room in the Saturday class?"}' \
  http://localhost:5173/f/YOUR_PUBLIC_ID
```

The queue consumer picks the message up a few seconds later. Locally there is no Workers AI binding, so every message is quarantined with the reason **Analysis unavailable**. Click **Refresh** in **To review** to see it; you can then open, accept, or archive it. [docs/forms.md](./forms.md) describes the form URL, its responses, and its limits.

## Checks

The repository is a pnpm workspace. `apps/rondyr/` is the Worker and its dashboard, `packages/emdash-plugin/` the EmDash plugin, and `tooling/` the lint rules and shared TypeScript settings. In `apps/rondyr/src/`, `domain/` has the rules that the Worker and dashboard share, `worker/` the code that runs in workerd, and `dashboard/` the React app; a new file in `dashboard/routes/` is a new address, and `pnpm dev` or `pnpm build` writes `dashboard/route-tree.gen.ts`. Dependency versions are in the catalog of `pnpm-workspace.yaml`. Run the commands from the root; they run in each package.

```sh
pnpm check         # lint, format, types, tests in workerd and Node, Knip, migrations, for every package
pnpm deploy:dry    # build, validate the bundle with Wrangler, check its size budget
```

CI runs both commands without Cloudflare credentials, and runs `pnpm test:e2e`, which ends with the dev-server check that `pnpm --filter rondyr test:dev` also runs. The browser tests attach a Chromium CDP virtual WebAuthn authenticator so passkey setup, sign-in, invitations, and Account Security are exercised end to end. The dev-server check starts `pnpm dev` on a database of its own, creates the owner with a real P-256 passkey, posts a submission, and fails if the queue consumer leaves it `received`. The integration tests build the Worker first and run it in workerd with D1, the queues, and the Durable Objects emulated. The tests of the classifier evaluation harness in `apps/rondyr/evals/` run in Node; `pnpm evaluate --dry evals/corpus/synthetic.jsonl` runs it without credentials, and [docs/evaluation.md](./evaluation.md) covers real runs. [CONTRIBUTING.md](../CONTRIBUTING.md) covers the dashboard browser tests and pull requests.

After a schema change in `apps/rondyr/src/worker/adapters/database`, run `pnpm db:generate --name your-migration-name`, read the generated SQL, and commit the new folder in `apps/rondyr/database/migrations`. `pnpm dev:alchemy` runs the Alchemy stack locally with its own state and D1 database, as an alternative to `pnpm dev`.
