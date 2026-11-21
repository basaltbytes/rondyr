# Deployment

Rondyr deploys to Cloudflare with [Alchemy](https://alchemy.run). Each stage has its own Worker, D1 database, queues, and Durable Objects, so `staging` and `prod` share nothing.

No one has followed this guide on a Cloudflare account other than the Basaltbytes one yet. The [fresh account checklist](#fresh-account-checklist) at the end of this page is the way to check it: follow it on a new account, tick each step, and fix this page where it differs.

## Prerequisites

- A Cloudflare account with a `workers.dev` subdomain enabled. Plan on Workers Paid; [Costs and plan limits](#costs-and-plan-limits) says why.
- For `prod`, a domain in an active zone of the same account: the domain uses Cloudflare's nameservers.
- Node.js 24.22 or later and pnpm 11, as for local development.
- For deployment from GitHub Actions, a fork or a copy of the repository where you can set secrets and variables.

## Cloudflare account setup

Do these two steps once per Cloudflare account, before the first deployment from GitHub Actions. A first deployment from your machine with an Alchemy profile can also create the state store; see [First deployment](#first-deployment).

### Alchemy state

Alchemy keeps the state of each stage in a store on the Cloudflare account. Create it once:

```sh
pnpm exec alchemy state bootstrap --backend cloudflare --config alchemy-run.ts
```

### API token

Create a Cloudflare account API token for CI only. On the account of the Worker, grant:

- `Workers Scripts Write`
- `D1 Write`
- `Queues Write`
- `Account Settings Read`
- **Account Secrets Store Edit**, which Alchemy calls `Secrets Store Write`. Alchemy needs it to bind the state secret to its preview Worker. See [Secrets Store permissions](https://developers.cloudflare.com/secrets-store/access-control/).

On the zone of the custom domain, grant `Zone Read` and `Workers Routes Write`. Set the token as the `CLOUDFLARE_API_TOKEN` secret of the repository, and the account ID as `CLOUDFLARE_ACCOUNT_ID`.

## Stage environment

Create one environment file per stage, for example `.env.staging`.

| Variable | Required | Value |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | Yes | At least 32 characters. Generate it with `openssl rand -hex 32` |
| `BETTER_AUTH_URL` | Yes | The HTTPS origin of the Worker, with no path and no custom port |
| `RONDYR_SETUP_TOKEN` | Only for the first account | A second value from `openssl rand -hex 32` |
| `RONDYR_SECRETS_KEY` | Only for webhooks and Turnstile | 32 bytes in base64, from `openssl rand -base64 32`. See [Encryption key](#encryption-key) |
| `RONDYR_CLASSIFIER` | No | `jev` (default) or `openai` |
| `RONDYR_ESCALATION_CLASSIFIER` | No | `jev` or `openai` as the second classifier. An unset value or the primary classifier disables escalation. |
| `RESEND_API_KEY` | Only for Resend | A Resend API key with sending access. See [Email](#email) |
| `RONDYR_EMAIL_FROM` | Only for email | A bare sender address on a domain configured with the selected provider, such as `forms@notifications.example.com` |
| `RONDYR_EMAIL_PROVIDER` | No | `resend` (default) or `cloudflare` |

For the Worker `rondyr-staging`, the origin is `https://rondyr-staging.<subdomain>.workers.dev`. For `prod`, Alchemy attaches the hostname of `BETTER_AUTH_URL` to the Worker `rondyr-prod` as a custom domain, and Cloudflare manages its DNS record and TLS certificate.

## First deployment

Connect your Cloudflare account in Alchemy, then plan and deploy `staging` before `prod`:

```sh
pnpm exec alchemy profile edit --config alchemy-run.ts --add Cloudflare
pnpm deploy:plan --stage staging --env-file .env.staging
pnpm run deploy --stage staging --env-file .env.staging
```

On the first plan or deployment, Alchemy can offer to create its state Worker. Pass `--profile` to select another Cloudflare account configured in Alchemy. See [Alchemy accounts and profiles](https://alchemy.run/cloudflare/accounts-and-tokens/) and [shared state](https://alchemy.run/state-store/).

The stack deploys the Worker with the Vite assets and the Durable Objects of the domain model. It applies the D1 migrations, and it configures the classification and delivery queues, their dead-letter queues and consumers, and the cron trigger that runs every minute. The Worker receives the generated queue names as `CLASSIFICATION_QUEUE_NAME`, `DELIVERY_QUEUE_NAME`, `CLASSIFICATION_DEAD_LETTER_QUEUE_NAME` and `DELIVERY_DEAD_LETTER_QUEUE_NAME` to tell the four queues apart. Each dead-letter queue has a consumer that logs and acknowledges its messages; see [Dead-letter queues](./operations.md#dead-letter-queues).

The Worker also gets the Rate Limiting binding `CLIENT_RATE_LIMIT`, which limits each client to 5 submissions per minute on a form. Nothing has to be created on the account for it, and the API token needs no permission beyond `Workers Scripts Write`; the limit and the namespace come from `ratelimits` in `wrangler.json`, which the stack reads. A namespace is shared by every Worker of the account: the stages of one account all use namespace `7001`, and they don't share counts because each key starts with the public ID of a form. Another Worker of the account that uses the same namespace would share a count only for an identical key. Cloudflare doesn't show rate limits in the dashboard; see [Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

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

To offer a second opinion for ambiguous submissions, set `RONDYR_ESCALATION_CLASSIFIER=openai` when Jev is primary, or `RONDYR_ESCALATION_CLASSIFIER=jev` when OpenAI Decisions is primary. Each organization opts in under **Settings → Classification**; on a stage without a different second classifier, that switch is disabled. The second model only settles the spam score: a submission that the primary model scores as sales outreach, or as off-topic when the organization reviews off-topic submissions, stays in quarantine. An eligible submission can add a model call and its retries to the classification time and cost, and uses one more slot of the organization's daily classification quota. When the quota is used up, the second model isn't called and the submission stays in quarantine as ambiguous.

The stack doesn't create the `default` gateway. When an account has no gateway with that name, AI Gateway creates it on the first authenticated request, with log collection on; see [Manage gateways](https://developers.cloudflare.com/ai-gateway/configuration/manage-gateway/). Jev calls made with the Workers AI binding go through the same gateway. The Worker turns log collection and caching off on every call of both classifiers, so the submission fields aren't stored in the gateway logs even with the gateway setting on. Logs written before this was in place stay in the gateway until you delete them.

The two classifiers have different default relevance thresholds, measured on a labeled corpus: 0.50 for Jev and 0.45 for OpenAI Decisions. [docs/evaluation.md](./evaluation.md) has the measurements.

## Encryption key

`RONDYR_SECRETS_KEY` is the AES-256-GCM key that encrypts two kinds of secrets in D1: the signing secret of each webhook and the Turnstile secret key of each form. It is optional. Without it, the dashboard and the API refuse to create a webhook, rotate its secret, or save a form's Turnstile keys, and everything else works. Set it on a stage before its first webhook or Turnstile widget:

```sh
openssl rand -base64 32
```

Add the value to the stage environment file, or to the `RONDYR_SECRETS_KEY_STAGING` or `RONDYR_SECRETS_KEY_PROD` GitHub secret, and redeploy.

Keep the key once webhooks or Turnstile keys exist. If you remove or change it, every delivery to an existing webhook fails without a retry, because its secret no longer decrypts. To recover with a new key, rotate the secret of each webhook and give the new secret to its recipient. Stored Turnstile secret keys don't decrypt either: intake logs a warning and sends the form's messages to classification without checking their Turnstile token, until you save the form's Turnstile keys again. Until then, the Turnstile card of each of those forms in **Forms** warns that Turnstile isn't protecting it. A value that isn't 32 bytes of base64 counts as missing.

[docs/webhooks.md](./webhooks.md) covers the payload, the signature, and the destination rules.

## Email

Email destinations require `RONDYR_EMAIL_FROM` and the selected provider's key or binding. If a setting is missing, the stage still deploys, creating an email destination answers `503` with `{"error":"email-provider-missing"}`, and a delivery to an existing email destination fails without a retry. When supplied, the sender must be a bare address such as `forms@example.com`.

For Resend, set `RESEND_API_KEY` and `RONDYR_EMAIL_FROM` in the stage environment, then redeploy. Use a separate API key per stage. The GitHub workflow reads `RESEND_API_KEY_STAGING` or `RESEND_API_KEY_PROD` from secrets and `RONDYR_EMAIL_FROM_STAGING` or `RONDYR_EMAIL_FROM_PROD` from variables.

For Cloudflare, onboard the sender domain, set `RONDYR_EMAIL_PROVIDER=cloudflare` and `RONDYR_EMAIL_FROM` on the stage, then redeploy. Alchemy adds `CLOUDFLARE_EMAIL` only to the Worker for that stage. In GitHub, set the corresponding `RONDYR_EMAIL_PROVIDER_STAGING` or `RONDYR_EMAIL_PROVIDER_PROD` variable alongside the sender variable. Cloudflare Email Sending uses a native binding and requires no extra secret. [Email setup, limits and retries](./email.md#setup-with-cloudflare-email-sending)

For local development with the Cloudflare simulator, set `RONDYR_EMAIL_FROM` in `.env` and run `CLOUDFLARE_ENV=cloudflare-email pnpm dev`. The named Wrangler environment enables the binding locally. Cloudflare's local simulator captures emails without delivering them. [Local Email Sending](https://developers.cloudflare.com/email-service/observability/local-development/sending/)

## GitHub Actions

Pull requests run `pnpm check` and `pnpm deploy:dry` in one job and the dashboard browser tests (`pnpm test:e2e`) in another. A push to `main`, including a merge, runs the same two jobs and deploys only if both pass. What it deploys depends on the [staging gate](#staging-gate):

- **Staging configured** (`BETTER_AUTH_URL_STAGING` and `BETTER_AUTH_SECRET_STAGING` are set): the workflow deploys `staging`, checks its `/health` and, when the submission check is set up, a submission through the inbox. It deploys `prod` only if staging deploys and passes these checks.
- **Staging not configured**: the workflow deploys `prod` directly. The run shows the notice `Staging is not configured`.

To deploy by hand, start the **Deploy** workflow and choose `staging` (the default) or `prod`. A manual `prod` deployment runs only from `main`. A manual `staging` deployment runs the same checks as the gate and never deploys `prod`. Use it for the first setup of staging.

Without `CLOUDFLARE_API_TOKEN`, the workflow skips cloud deployment.

| Name | Kind | Stage |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Secret | Both |
| `BETTER_AUTH_SECRET_PROD`, `BETTER_AUTH_SECRET_STAGING` | Secret | One each. The staging one turns on the [staging gate](#staging-gate) |
| `BETTER_AUTH_URL_PROD`, `BETTER_AUTH_URL_STAGING` | Variable | One each. The staging one turns on the [staging gate](#staging-gate) |
| `RONDYR_SETUP_TOKEN_PROD`, `RONDYR_SETUP_TOKEN_STAGING` | Secret, optional | One each |
| `RONDYR_SECRETS_KEY_PROD`, `RONDYR_SECRETS_KEY_STAGING` | Secret, optional | One each |
| `RONDYR_CLASSIFIER_PROD`, `RONDYR_CLASSIFIER_STAGING` | Variable, optional | One each |
| `RONDYR_ESCALATION_CLASSIFIER_PROD`, `RONDYR_ESCALATION_CLASSIFIER_STAGING` | Variable, optional | One each |
| `RESEND_API_KEY_PROD`, `RESEND_API_KEY_STAGING` | Secret, optional | One each |
| `RONDYR_EMAIL_FROM_PROD`, `RONDYR_EMAIL_FROM_STAGING` | Variable, optional | One each |
| `RONDYR_EMAIL_PROVIDER_PROD`, `RONDYR_EMAIL_PROVIDER_STAGING` | Variable, optional | One each |
| `RONDYR_SMOKE_FORM_ID_STAGING` | Variable, optional, [submission check](#submission-check) | Staging |
| `RONDYR_SMOKE_API_TOKEN_STAGING` | Secret, optional, [submission check](#submission-check) | Staging |

For the Basaltbytes repository, `BETTER_AUTH_URL_PROD` is `https://rondyr.basaltbytes.com`. Delete the setup token secret once the first account exists.

### Staging gate

The gate is on when `BETTER_AUTH_URL_STAGING` and `BETTER_AUTH_SECRET_STAGING` are both set in GitHub. A push to `main` then deploys `staging` first, with its D1 migrations, and runs `scripts/smoke-staging.mjs` against it. The script checks that `/health` answers `ok`, then runs the [submission check](#submission-check) if it is set up. `prod` deploys only after staging passes. With neither staging setting, a push deploys `prod` directly. With only one of them, the push fails before any deployment, and the error names the missing setting, never a value.

To turn the gate on:

1. Set `BETTER_AUTH_URL_STAGING` to `https://rondyr-staging.<subdomain>.workers.dev` and `BETTER_AUTH_SECRET_STAGING` to a value from `openssl rand -hex 32`. The smoke test refuses any other origin than the `rondyr-staging` `workers.dev` host.
2. Start the **Deploy** workflow with stage `staging`. The run deploys staging and checks `/health`. From the next push to `main`, staging deploys before `prod`.

### Submission check

The submission check goes further than `/health`: it submits one synthetic message to a test form on staging, reads it back with an API token, and waits up to three minutes for the normal classifier to accept it or place it in quarantine. A classifier error or a quarantine at intake fails the check. It needs two settings: the variable `RONDYR_SMOKE_FORM_ID_STAGING` and the secret `RONDYR_SMOKE_API_TOKEN_STAGING`. Set both or neither: with one of them, a push fails before any deployment.

To set it up, once, after the [staging gate](#staging-gate):

1. Set `RONDYR_SETUP_TOKEN_STAGING` to a value from `openssl rand -hex 32`, then start the **Deploy** workflow with stage `staging`.
2. Create the staging account. The script asks for the setup token from step 1, then for a name, an email address and a password. The script creates only the first account of a stage: if staging already has one, sign in with it instead.

   ```sh
   ./scripts/setup-owner.sh https://rondyr-staging.<subdomain>.workers.dev
   ```

3. Sign in at the staging origin. Create an organization and its first form with **Create organization**. A pottery workshop is suitable business context for the synthetic enquiry. Leave the form active, add no honeypot field, webhook or email destination, so that the test sends no notification.
4. In **Forms**, copy the form's public ID: the last part of its submission URL, after `/f/`.
5. In **Settings → API tokens**, create a token named `CI smoke test` and copy it. Rondyr shows it once.
6. In the repository settings, set the variable `RONDYR_SMOKE_FORM_ID_STAGING` to the public ID and the secret `RONDYR_SMOKE_API_TOKEN_STAGING` to the token.
7. Delete `RONDYR_SETUP_TOKEN_STAGING`, then start the **Deploy** workflow with stage `staging` again. The step **Verify staging health and submission processing** prints `Staging health and submission processing passed.`

The token can read and review the inbox of the test organization only. To revoke it, revoke it in **Settings → API tokens** and set a new one in GitHub. Keep the test form separate from forms used by people. Each run leaves a message in staging.

When a check fails, the job `staging / Deploy staging` of the CI run is red, `production` is skipped, and production keeps its previous version. The step **Verify staging health and submission processing** prints one line, for example `Staging returned HTTP 401; expected 200 for /api/organizations` or `Staging did not classify the smoke submission within three minutes.`, and never a response body or credential. A partial configuration fails the job **Staging gate configuration** instead, before any deployment. Fix staging or the settings, then push again or re-run the failed jobs. See [the runbook](./operations.md#staging-gate) for the diagnosis.

## Costs and plan limits

Rondyr runs on your Cloudflare account and bills nothing itself, but it is not free to run. Cloudflare bills each product it uses, and its prices and limits change: check the linked pages before you rely on the figures below, which date from November 2026. Nobody has measured Rondyr on a Workers Free account.

Plan on [Workers Paid](https://developers.cloudflare.com/workers/platform/pricing/), at least $5 a month per account, for three reasons:

- Workers Free allows 10 ms of CPU time per invocation. Signing in hashes the password with scrypt, which is designed to take more CPU than that, and the Worker's start-up adds to every request. Sign-in and other requests can fail on Free.
- Workers Free allows 10,000 queue operations a day. A message takes about 3 operations to reach the classifier and 3 more for each delivery, so a few thousand messages a day use it up, and a spam wave can do it in minutes.
- Cloudflare Email Sending needs Workers Paid.

Each stage has its own resources and its own usage. A stage with no traffic still runs the Cron every minute: 1,440 Worker invocations a day, each with a few D1 queries and one Durable Object request to record its success. Each message adds a Worker request, a D1 transaction, queue operations, several Durable Object requests, one classifier call, and the same again for each delivery.

| Product | What Rondyr uses it for | Workers Free | Workers Paid |
| --- | --- | --- | --- |
| [Workers](https://developers.cloudflare.com/workers/platform/pricing/) | Intake, dashboard API, Cron, queue consumers | 100,000 requests a day, 10 ms CPU per invocation | 10 million requests and 30 million CPU ms a month included, then $0.30 per million requests and $0.02 per million CPU ms |
| [D1](https://developers.cloudflare.com/d1/platform/pricing/) | Messages, outbox, deliveries, accounts | 5 million rows read and 100,000 rows written a day, 5 GB | 25 billion rows read and 50 million rows written a month included, then $0.001 and $1.00 per million, 5 GB included then $0.75 per GB-month |
| [Queues](https://developers.cloudflare.com/queues/platform/pricing/) | Classification, delivery and dead-letter queues | 10,000 operations a day, 24-hour retention | 1 million operations a month included, then $0.40 per million |
| [Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/) | Event stream of each message, classification runs, Inbox projection, Cron heartbeat | 100,000 requests and 13,000 GB-s a day | 1 million requests and 400,000 GB-s a month included, then $0.15 per million requests and $12.50 per million GB-s |
| [Workers AI](https://developers.cloudflare.com/workers-ai/platform/pricing/) | Jev, the default classifier | 10,000 Neurons a day, then calls fail | The same 10,000 Neurons a day, then $0.011 per 1,000 Neurons |
| [AI Gateway](https://developers.cloudflare.com/ai-gateway/reference/pricing/) | The `default` gateway in front of both classifiers | No charge for the gateway. Rondyr turns log storage off on each call | Same |
| [Unified billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/) | OpenAI Decisions, when `RONDYR_CLASSIFIER=openai` or as the second model | Prepaid credits, per call | Same |
| [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) | The Worker's logs, which the runbook relies on | 200,000 log events a day, 3 days of retention | 20 million a month included, then $0.60 per million, 7 days of retention. Cloudflare moves Workers Logs to its Observability pricing on 1 December 2026 |
| [Cron Triggers](https://developers.cloudflare.com/workers/platform/limits/) | One per stage | 5 per account | 250 per account |
| Email | Email destinations | [Resend](./email.md#resend-limits-and-cost) has its own plans. Cloudflare Email Sending is not available | [Cloudflare Email Sending](./email.md#cloudflare-limits-and-cost): 3,000 emails a month included, then $0.35 per 1,000 |

When a Workers Free limit is reached, Cloudflare refuses the excess until midnight UTC instead of billing it. For Rondyr that means refused submissions (`503` or Cloudflare's own error page), messages quarantined with **Analysis unavailable** when the Workers AI allowance runs out, and messages that wait in a queue. The stored messages are not lost, but nothing alerts you. On Workers Paid, usage over the included amounts is billed. The organization quotas in **Daily quotas** cap stored submissions and classifications per organization; they are the main lever on the classifier's cost. Check usage in the Cloudflare dashboard under **Workers & Pages**, **D1**, **Queues** and **AI**, and set billing notifications on the account.

## Fresh account checklist

This list checks the guide on a Cloudflare account that has never run Rondyr. It needs a person: a new Cloudflare account, a domain and credentials that an agent does not have. Copy it into an issue or a pull request, tick each step, and for each one note what differed from this page: a missing permission, a step in another order, a delay, an error message. Fix this page and the other guides in the same pull request.

Before you start, write down the date, the commit of Rondyr, and the Cloudflare plan of the account.

### 1. Account, state and API token

- [ ] The account has Workers Paid, a `workers.dev` subdomain, and the domain of `prod` as an active zone. Note how long the zone took to become active.
- [ ] Bootstrap the Alchemy state with `pnpm exec alchemy state bootstrap --backend cloudflare --config alchemy-run.ts`, as in [Alchemy state](#alchemy-state). Note what the command creates in the account and every prompt it shows.
- [ ] Create the API token with exactly the permissions of [API token](#api-token), and nothing more. Keep the list of permissions you had to add during the steps below.
- [ ] In a fork or a copy of the repository, set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, then the variables and secrets of both stages from [GitHub Actions](#github-actions): `BETTER_AUTH_URL_STAGING`, `BETTER_AUTH_SECRET_STAGING`, `BETTER_AUTH_URL_PROD` (the custom domain), `BETTER_AUTH_SECRET_PROD`, and `RONDYR_SETUP_TOKEN_STAGING` and `RONDYR_SETUP_TOKEN_PROD`.

### 2. First deployments

- [ ] Start the **Deploy** workflow with stage `staging`. It deploys staging and checks `/health`. Note the duration and any error.
- [ ] Push a commit to `main` of the fork, or merge a pull request. CI deploys `staging`, checks it, then deploys `prod`. Check that `prod` answers on the custom domain with a valid certificate, and note how long the certificate took.
- [ ] In the Cloudflare dashboard, check that each resource exists for each stage, without any manual step that this page does not describe:
  - [ ] the D1 database, with every migration of `database/migrations` applied: in the D1 console, `outbox_events` has the columns `publication_count` and `stuck_at`, which the last migration adds;
  - [ ] the classification queue and the delivery queue, each with its dead-letter queue, and four consumers on the Worker: one per queue and one per dead-letter queue;
  - [ ] the Cron trigger `* * * * *` on the Worker, and a **Last successful Cron run** on **Status** after the first sign-in;
  - [ ] the Durable Object classes of `wrangler.json`, listed under the Worker's bindings;
  - [ ] the Rate Limiting binding `CLIENT_RATE_LIMIT` under the Worker's bindings. Cloudflare does not show rate limits elsewhere.
- [ ] Check the security headers of the dashboard with the `curl` command of [First deployment](#first-deployment), on both stages.

### 3. First account and first message

- [ ] On `prod`, create the first account with `./scripts/setup-owner.sh <origin>` ([First account](#first-account)), then sign in.
- [ ] Delete `RONDYR_SETUP_TOKEN_PROD` in GitHub and deploy `prod` again. Check that `POST /api/setup` now answers `404`.
- [ ] Create an organization and a form with a business context, and send a message with `curl` as in the README. Check that it is accepted or quarantined with a reason other than **Analysis unavailable**, within a minute.
- [ ] Check **Status**: the Cron run is recent, and the outbox and stuck counts are zero.

### 4. AI gateway

- [ ] In **AI → AI Gateway**, check that the gateway `default` exists after the first classified message, and that it was created with log collection on. Note whether you had to create it.
- [ ] Open its logs and confirm that no entry holds a message: Rondyr turns log collection off on each call. Note anything that the gateway stored for these calls.

### 5. Optional features, one at a time

For each feature, set its settings, deploy, use the feature, and note what it required beyond this page.

- [ ] Webhooks: set `RONDYR_SECRETS_KEY_PROD` ([Encryption key](#encryption-key)), deploy, add a webhook destination, send a test, and verify a signature with [docs/webhooks.md](./webhooks.md).
- [ ] Email with Resend: set `RESEND_API_KEY_PROD` and `RONDYR_EMAIL_FROM_PROD` ([docs/email.md](./email.md#setup-with-resend)), deploy, add an email destination and send a test.
- [ ] Email with Cloudflare, if the account sends with it: set `RONDYR_EMAIL_PROVIDER_PROD=cloudflare` and the sender ([docs/email.md](./email.md#setup-with-cloudflare-email-sending)), deploy, and send a test.
- [ ] OpenAI Decisions: load credits for [unified billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/), check that the `default` gateway does not require provider credentials, set `RONDYR_CLASSIFIER_PROD=openai`, deploy, and send a message. Note the cost of a message in the credit balance.
- [ ] Staging submission check: follow [Submission check](#submission-check), then push to `main` and check the step **Verify staging health and submission processing**.

### 6. Costs and recovery

- [ ] After a day, note the usage of each product in [Costs and plan limits](#costs-and-plan-limits) for the stage with no traffic and for the stage that received messages, and correct the table where it is wrong.
- [ ] Rehearse a D1 restore and a Worker rollback on staging with the [operations runbook](./operations.md#restore-d1-with-time-travel), and correct the runbook from what you observe.

For queue diagnosis, recovery, and secret rotation, see the [operations runbook](./operations.md).
