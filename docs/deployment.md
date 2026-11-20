# Deployment

Rondyr deploys to Cloudflare with [Alchemy](https://alchemy.run). Each stage has its own Worker, D1 database, queues, and Durable Objects, so `staging` and `prod` share nothing.

No one has followed this guide on a Cloudflare account other than the Basaltbytes one yet; [#12](https://github.com/basaltbytes/rondyr/issues/12) tracks that check.

## Prerequisites

- A Cloudflare account with a `workers.dev` subdomain enabled.
- For `prod`, a domain in an active zone of the same account.
- Node.js 24.22 or later and pnpm 11, as for local development.

## Stage environment

Create one environment file per stage, for example `.env.staging`.

| Variable | Required | Value |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | Yes | At least 32 characters. Generate it with `openssl rand -hex 32` |
| `BETTER_AUTH_URL` | Yes | The HTTPS origin of the Worker, with no path and no custom port |
| `RONDYR_SETUP_TOKEN` | Only for the first account | A second value from `openssl rand -hex 32` |
| `RONDYR_CLASSIFIER` | No | `jev` (default) or `openai` |

For the Worker `rondyr-staging`, the origin is `https://rondyr-staging.<subdomain>.workers.dev`. For `prod`, Alchemy attaches the hostname of `BETTER_AUTH_URL` to the Worker `rondyr-prod` as a custom domain, and Cloudflare manages its DNS record and TLS certificate.

## First deployment

Connect your Cloudflare account in Alchemy, then plan and deploy `staging` before `prod`:

```sh
pnpm exec alchemy profile edit --config alchemy-run.ts --add Cloudflare
pnpm deploy:plan --stage staging --env-file .env.staging
pnpm run deploy --stage staging --env-file .env.staging
```

On the first plan or deployment, Alchemy can offer to create its state Worker. Pass `--profile` to select another Cloudflare account configured in Alchemy. See [Alchemy accounts and profiles](https://alchemy.run/cloudflare/accounts-and-tokens/) and [shared state](https://alchemy.run/state-store/).

The stack deploys the Worker with the Vite assets and the Durable Objects of the domain model. It applies the D1 migrations, and it configures the classification queue, its dead-letter queue, and the cron trigger that runs every minute. It also creates the delivery queue, which nothing uses until [#5](https://github.com/basaltbytes/rondyr/issues/5) is done.

The dashboard assets get their security headers from `public/_headers`. After a deployment, check them on the stage origin:

```sh
curl -sI https://rondyr-staging.<subdomain>.workers.dev/ | grep -iE 'content-security-policy|strict-transport-security|x-frame-options|x-content-type-options|referrer-policy'
```

## First account

Public sign-up is closed. With `RONDYR_SETUP_TOKEN` set on the stage, run the setup script against the stage origin:

```sh
./scripts/setup-owner.sh https://rondyr-staging.<subdomain>.workers.dev
```

The script reads `RONDYR_SETUP_TOKEN` from the environment or asks for it, then asks for a name, an email address, and a password of 12 to 128 characters. After the `201` response, sign in at `/`. Remove the setup token from the stage configuration and redeploy. D1 refuses a second account through this endpoint even while the token is still set.

If an organization already exists in SQL, give an account access by adding a row to `organization_members` with the `organization_id` and the Better Auth `user_id`.

## Classifier

Jev is the default classifier, and the deployed Worker calls it through the Workers AI binding.

To use OpenAI Decisions with GPT-6 Luna instead, set `RONDYR_CLASSIFIER=openai` in the stage environment and redeploy. The choice applies to every form of the stage. The Worker calls `openai/decisions` through the `AI` binding and the AI Gateway named `default`. With Cloudflare unified billing, the calls use the account's credits and Rondyr needs no OpenAI key. See the [Decisions model](https://developers.cloudflare.com/ai/models/openai/decisions/) and [unified billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/).

The stack doesn't create the `default` gateway. When an account has no gateway with that name, AI Gateway creates it on the first authenticated request, with log collection on; see [Manage gateways](https://developers.cloudflare.com/ai-gateway/configuration/manage-gateway/). The Worker turns log collection and caching off on each OpenAI Decisions call, so these requests aren't logged even with the gateway's default settings. Other callers of the same gateway on the account keep its settings. Jev doesn't go through AI Gateway.

Both classifiers use the same thresholds today, although their scores haven't been compared on a test corpus ([#6](https://github.com/basaltbytes/rondyr/issues/6)).

## GitHub Actions

A push to `main`, including a merge, runs `pnpm check` and `pnpm deploy:dry`, then deploys `prod`. The **Deploy** workflow deploys `staging` when you start it by hand. Without `CLOUDFLARE_API_TOKEN`, the workflow runs the checks and reports that the deployment was skipped.

| Name | Kind | Stage |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Secret | Both |
| `BETTER_AUTH_SECRET_PROD`, `BETTER_AUTH_SECRET_STAGING` | Secret | One each |
| `BETTER_AUTH_URL_PROD`, `BETTER_AUTH_URL_STAGING` | Variable | One each |
| `RONDYR_SETUP_TOKEN_PROD`, `RONDYR_SETUP_TOKEN_STAGING` | Secret, optional | One each |
| `RONDYR_CLASSIFIER_PROD`, `RONDYR_CLASSIFIER_STAGING` | Variable, optional | One each |

For the Basaltbytes repository, `BETTER_AUTH_URL_PROD` is `https://rondyr.basaltbytes.com`. Delete the setup token secret once the first account exists.

### API token

Create a Cloudflare account API token for CI only. On the account of the Worker, grant:

- `Workers Scripts Write`
- `D1 Write`
- `Queues Write`
- `Account Settings Read`
- **Account Secrets Store Edit**, which Alchemy calls `Secrets Store Write`. Alchemy needs it to bind the state secret to its preview Worker. See [Secrets Store permissions](https://developers.cloudflare.com/secrets-store/access-control/).

On the zone of the custom domain, grant `Zone Read` and `Workers Routes Write`.

### Alchemy state

Create the Alchemy state store on the Cloudflare account once, before the first non-interactive deployment:

```sh
pnpm exec alchemy state bootstrap --backend cloudflare --config alchemy-run.ts
```

## Known gaps

- Every merge to `main` deploys `prod` and applies its D1 migrations, with no `staging` step before it.
- Backup, restore, and rollback aren't documented. A D1 restore doesn't rewind the Durable Objects or the Alchemy state to the same point in time. [#10](https://github.com/basaltbytes/rondyr/issues/10) tracks both points.
