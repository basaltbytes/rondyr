# Deployment

Rondyr runs on your own Cloudflare account. You deploy it with [Alchemy](https://alchemy.run), from your machine or from GitHub Actions on each push to `main`. A deployment is an Alchemy stage named `prod`, with its own Worker, D1 database, queues and Durable Objects, served on a domain of yours.

So far this guide has only been followed on the Cloudflare account of the people who wrote it. The [fresh account checklist](#fresh-account-checklist) at the end of this page walks through a first installation on a new account. If a step differs from what you see, open an issue or a pull request that fixes this page.

## Prerequisites

- A Cloudflare account. Plan on Workers Paid; [Costs and plan limits](#costs-and-plan-limits) says why.
- A domain in an active zone of the same account, for the address of Rondyr: the domain uses Cloudflare's nameservers.
- Node.js 24.22 or later and pnpm 11, as for local development.
- To deploy from GitHub Actions, a fork or a copy of the repository where you can set secrets and variables.

## Cloudflare account setup

Do these two steps once per Cloudflare account, before the first deployment from GitHub Actions. A first deployment from your machine with an Alchemy profile can also create the state store; see [First deployment](#first-deployment).

### Alchemy state

Alchemy keeps the state of each stage in a store on the Cloudflare account. Create it once:

```sh
pnpm --filter rondyr exec alchemy state bootstrap --backend cloudflare --config alchemy-run.ts
```

The Alchemy commands run in `apps/rondyr/`, where `alchemy-run.ts` is: `pnpm --filter rondyr exec` runs them there from the repository root.

### API token

Create a Cloudflare account API token for GitHub Actions only. On the account of the Worker, grant:

- `Workers Scripts Write`
- `D1 Write`
- `Queues Write`
- `Account Settings Read`
- **Account Secrets Store Edit**, which Alchemy calls `Secrets Store Write`. Alchemy needs it to bind the state secret to its preview Worker. See [Secrets Store permissions](https://developers.cloudflare.com/secrets-store/access-control/).

On the zone of your domain, grant `Zone Read` and `Workers Routes Write`. Set the token as the `CLOUDFLARE_API_TOKEN` secret of the repository, and the account ID as `CLOUDFLARE_ACCOUNT_ID`.

## Environment

To deploy from your machine, create an environment file in `apps/rondyr/`, for example `apps/rondyr/.env.prod`. The deployment commands run in that folder, so `--env-file .env.prod` finds it there. GitHub Actions reads the same settings from the repository's secrets and variables; see [GitHub Actions](#github-actions).

| Variable | Required | Value |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | Yes | At least 32 characters. Generate it with `openssl rand -hex 32` |
| `BETTER_AUTH_URL` | Yes | The HTTPS origin of Rondyr, with no path and no custom port, such as `https://forms.example.com` |
| `RONDYR_SETUP_TOKEN` | Only for the first account | A second value from `openssl rand -hex 32` |
| `RONDYR_SECRETS_KEY` | Only for webhooks and Turnstile | 32 bytes in base64, from `openssl rand -base64 32`. See [Encryption key](#encryption-key) |
| `RONDYR_CLASSIFIER` | No | `jev` (default) or `openai` |
| `RONDYR_ESCALATION_CLASSIFIER` | No | `jev` or `openai` as the second classifier. An unset value or the primary classifier disables escalation. |
| `RESEND_API_KEY` | Only for Resend | A Resend API key with sending access. See [Email](#email) |
| `RONDYR_EMAIL_FROM` | Only for email | A bare sender address on a domain configured with the selected provider, such as `forms@notifications.example.com` |
| `RONDYR_EMAIL_PROVIDER` | No | `resend` (default) or `cloudflare` |

Alchemy attaches the hostname of `BETTER_AUTH_URL` to the Worker `rondyr-prod` as a custom domain, and Cloudflare manages its DNS record and TLS certificate.

## First deployment

Connect your Cloudflare account in Alchemy, then plan and deploy the `prod` stage:

```sh
pnpm --filter rondyr exec alchemy profile edit --config alchemy-run.ts --add Cloudflare
pnpm deploy:plan --stage prod --env-file .env.prod
pnpm run deploy --stage prod --env-file .env.prod
```

On the first plan or deployment, Alchemy can offer to create its state Worker. Pass `--profile` to select another Cloudflare account configured in Alchemy. See [Alchemy accounts and profiles](https://alchemy.run/cloudflare/accounts-and-tokens/) and [shared state](https://alchemy.run/state-store/).

The stack deploys the Worker with the Vite assets and the Durable Objects of the domain model. It applies the D1 migrations, and it configures the classification and delivery queues, their dead-letter queues and consumers, and the cron trigger that runs every minute. The Worker receives the generated queue names as `CLASSIFICATION_QUEUE_NAME`, `DELIVERY_QUEUE_NAME`, `CLASSIFICATION_DEAD_LETTER_QUEUE_NAME` and `DELIVERY_DEAD_LETTER_QUEUE_NAME` to tell the four queues apart. Each dead-letter queue has a consumer that logs and acknowledges its messages; see [Dead-letter queues](./operations.md#dead-letter-queues).

The Worker also gets the Rate Limiting binding `CLIENT_RATE_LIMIT`, which limits each client to 5 submissions per minute on a form. Nothing has to be created on the account for it, and the API token needs no permission beyond `Workers Scripts Write`; the limit and the namespace come from `ratelimits` in `apps/rondyr/wrangler.json`, which the stack reads. A namespace is shared by every Worker of the account: the stages of one account all use namespace `7001`, and they don't share counts because each key starts with the public ID of a form. Another Worker of the account that uses the same namespace would share a count only for an identical key. Cloudflare doesn't show rate limits in the dashboard; see [Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

A second Rate Limiting binding, `TARGET_TEST_RATE_LIMIT` in namespace `7002`, limits the test messages of each destination to 3 per minute. Its keys start with `target-test:` and the ID of the destination, so stages don't share counts either. Like the first one, it needs no setting: the stack declares it from `apps/rondyr/wrangler.json`, and `pnpm doctor` checks that both files declare it. If the binding doesn't answer, a test is refused with `503` and `{"error":"test-limit-unavailable"}`, sends nothing, and the dashboard says so.

A new custom domain can take a few minutes to get its DNS record and certificate. Wait for Rondyr to answer, up to 15 minutes, with the [smoke test](./operations.md#smoke-test):

```sh
pnpm smoke https://forms.example.com --health-timeout 900
```

The dashboard assets get their security headers from `apps/rondyr/public/_headers`. After a deployment, check them:

```sh
curl -sI https://forms.example.com/ | grep -iE 'content-security-policy|strict-transport-security|x-frame-options|x-content-type-options|referrer-policy'
```

### Trial copy

To try Rondyr, or a change, without touching your deployment, deploy a second stage by hand with the same commands, another stage name and its own environment file, for example `pnpm run deploy --stage trial --env-file .env.trial` with `apps/rondyr/.env.trial`. A stage other than `prod` gets its own Worker, D1 database, queues and Durable Objects, and the address `https://rondyr-trial.<subdomain>.workers.dev` instead of a custom domain: set that address as its `BETTER_AUTH_URL`, and enable a `workers.dev` subdomain on the account first. GitHub Actions never deploys it. Remove it with `pnpm --filter rondyr exec alchemy destroy --config alchemy-run.ts --stage trial --env-file .env.trial`.

## First account

Public sign-up is closed. With `RONDYR_SETUP_TOKEN` set, run the setup script against your origin:

```sh
./apps/rondyr/scripts/setup-owner.sh https://forms.example.com
```

The script reads `RONDYR_SETUP_TOKEN` from the environment or asks for it, then asks for a name, an email address, and a password of 12 to 128 characters. After the `201` response, sign in at `/`. Remove the setup token from the configuration and redeploy. D1 refuses a second account through this endpoint even while the token is still set.

The first account creates an organization in the dashboard and is its admin. Any signed-in account can create an organization and becomes its admin.

## Members and invitations

Every other person joins through an invitation. An admin opens **Settings → Members**, enters an email address and a role, and gets a link of the form `https://<origin>/invitation#<secret>`. The link works once, for 7 days; D1 keeps only the SHA-256 hash of the secret, which sits in the URL fragment so that no request or log carries it. When the stage sends email (see [Email](#email)), Rondyr also emails the link to the address, with fixed text that names neither the organization nor the person who invited. Rondyr emails an address at most 3 invitations in 24 hours across all organizations; past that, and on a stage without email, the admin copies the link from the dashboard and sends it another way.

The invited person opens the link. Without an account, they choose a name and a password of 12 to 128 characters, and the account gets the invited address. With an account at that address, they sign in, then join. A link opened while signed in with another address is refused.

| Role | Rights |
| --- | --- |
| `reviewer` | Reads the inbox and the delivery history, accepts and archives messages |
| `admin` | Everything else as well: forms, allowed origins, honeypot field, Turnstile, destinations, delivery retries and test sends, members, settings, API tokens, export, deletion and retention |

An admin can change a member's role or remove them in the same section. The last admin of an organization can be neither removed nor demoted; the SQL statement that changes the member checks it, so two admins who leave at the same time keep one of them. The same statement checks that the account that asks is still an admin, so a request that started before its author lost the role changes nothing. An admin who changes their own role to reviewer confirms it first, since only another admin can give it back.

Removing a member also revokes the API tokens that this member created in the organization, and cancels the invitations it issued. Before you confirm, the removal dialog says how many active tokens go with the member: a website or a script that uses one of them gets `401` from then on, so give it a token that another admin created first. A demoted admin keeps its tokens, which have the rights of a reviewer anyway, and loses its pending invitations. An invitation only works while the admin who issued it is still an admin of the organization.

The migration that added roles made every member that existed before it an admin. During the deployment, the previous Worker version still runs for a moment after the migration: a member that it adds, the creator of a new organization, gets the column's default, `admin`, the rights it had before roles. An API token acts as a reviewer of its organization.

## Forgotten passwords

On a stage that sends email, the sign-in screen has **Forgot your password?**. Rondyr emails the account a link of the form `https://<origin>/reset-password#<secret>`, valid once for one hour; D1 keeps only the SHA-256 hash of the secret. The screen answers the same whether an account has the address or not, the email leaves after the answer, and an account gets at most 3 links in 24 hours. Choosing a new password signs the account out of every session and marks its address as verified.

This is also how the owner of an address takes back an account that someone else created at it. An admin who opens a copied invitation link instead of sending it can create the account at the invited address without reading that mailbox; the account then belongs to the admin's organization only, and joining another organization takes that organization's own link, which goes to the mailbox. A reset from the mailbox replaces the admin's password and signs the admin out.

On a stage without email, nobody can prove that they read a mailbox: the sign-in screen says that the server can't reset a password, and the person who chose the password keeps the account.

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

Add the value to the environment file, or to the `RONDYR_SECRETS_KEY_PROD` GitHub secret, and redeploy.

Keep the key once webhooks or Turnstile keys exist. If you remove or change it, every delivery to an existing webhook fails without a retry, because its secret no longer decrypts. To recover with a new key, rotate the secret of each webhook and give the new secret to its recipient. Stored Turnstile secret keys don't decrypt either: intake logs a warning and sends the form's messages to classification without checking their Turnstile token, until you save the form's Turnstile keys again. Until then, the Turnstile card of each of those forms in **Forms** warns that Turnstile isn't protecting it. A value that isn't 32 bytes of base64 counts as missing.

[docs/webhooks.md](./webhooks.md) covers the payload, the signature, and the destination rules.

## Email

Email destinations require `RONDYR_EMAIL_FROM` and the selected provider's key or binding. If a setting is missing, the stage still deploys, creating an email destination answers `503` with `{"error":"email-provider-missing"}`, and a delivery to an existing email destination fails without a retry. When supplied, the sender must be a bare address such as `forms@example.com`.

For Resend, set `RESEND_API_KEY` and `RONDYR_EMAIL_FROM` in the stage environment, then redeploy. Use a separate API key for a trial copy. The GitHub workflow reads `RESEND_API_KEY_PROD` from secrets and `RONDYR_EMAIL_FROM_PROD` from variables.

For Cloudflare, onboard the sender domain, set `RONDYR_EMAIL_PROVIDER=cloudflare` and `RONDYR_EMAIL_FROM` on the stage, then redeploy. Alchemy adds `CLOUDFLARE_EMAIL` only to the Worker for that stage. In GitHub, set the `RONDYR_EMAIL_PROVIDER_PROD` variable alongside the sender variable. Cloudflare Email Sending uses a native binding and requires no extra secret. [Email setup, limits and retries](./email.md#setup-with-cloudflare-email-sending)

For local development with the Cloudflare simulator, set `RONDYR_EMAIL_FROM` in `apps/rondyr/.env` and run `CLOUDFLARE_ENV=cloudflare-email pnpm dev`. The named Wrangler environment enables the binding locally. Cloudflare's local simulator captures emails without delivering them. [Local Email Sending](https://developers.cloudflare.com/email-service/observability/local-development/sending/)

## GitHub Actions

Pull requests run `pnpm check` and `pnpm deploy:dry` in one job and the dashboard browser tests (`pnpm test:e2e`) in another. A push to `main`, including a merge, runs the same two jobs. If both pass and the Worker package changed (see **Changed packages** below), it deploys `prod`, applies the D1 migrations, and checks that `/health` answers `ok`. The check waits up to 15 minutes, the time a first deployment on a new domain can take for its DNS record and certificate. When `/health` does not answer in time, the step **Check production health** and the run fail with the error `Production health`; [the runbook](./operations.md#production-health-check) says what to check.

To redeploy by hand, start the **Deploy** workflow on `main`. Without `CLOUDFLARE_API_TOKEN`, the workflow skips the deployment.

Before any deployment, the **Changed packages** job asks pnpm which workspace packages changed since the commit of the last successful prod deployment (`pnpm --filter "...[<commit>]" list`, in `scripts/deploy-scope.mjs`). It finds that commit through the GitHub Actions API, in the recent push runs of this workflow and the recent manual runs of the **Deploy** workflow whose `Deploy prod` job succeeded, counting only runs of this repository's own commits so that a pull request from a fork cannot pass for a deployment, so a Worker change whose own run failed or was cancelled still deploys with the next push. The push deploys, and applies the D1 migrations, if the Worker package `rondyr` (`apps/rondyr/`) is among the changed packages, which pnpm also reports when a package it depends on changed. A change to `apps/rondyr/`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` (with its catalog of versions), the root `package.json`, `.nvmrc`, `patches/` or `.github/` counts as a Worker change. Any other changed file must belong to another changed package, such as `packages/emdash-plugin/` or `tooling/oxlint/`, or to the documentation (`README.md`, `architecture.md`, `AGENTS.md`, `CONTRIBUTING.md`, `docs/`, the agent instructions); otherwise the push deploys. A merge that touches only the plugin or the documentation runs the checks and deploys nothing. When in doubt the push deploys: no deployment found in the last 30 runs, a commit missing from the history, an API error, or a failure of the job itself. The job log and the run's notices end with `Deployment planned` or `Deployment skipped` and the reason; pull requests show the same line, compared with their base, and still run every check on every package.

The workflow reads these settings. The `_PROD` suffix names the `prod` stage that it deploys.

| Name | Kind |
| --- | --- |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Secret |
| `BETTER_AUTH_SECRET_PROD` | Secret |
| `BETTER_AUTH_URL_PROD` | Variable |
| `RONDYR_SETUP_TOKEN_PROD` | Secret, optional |
| `RONDYR_SECRETS_KEY_PROD` | Secret, optional |
| `RONDYR_CLASSIFIER_PROD` | Variable, optional |
| `RONDYR_ESCALATION_CLASSIFIER_PROD` | Variable, optional |
| `RESEND_API_KEY_PROD` | Secret, optional |
| `RONDYR_EMAIL_FROM_PROD` | Variable, optional |
| `RONDYR_EMAIL_PROVIDER_PROD` | Variable, optional |

Delete the setup token secret once the first account exists.

## Costs and plan limits

Rondyr runs on your Cloudflare account and bills nothing itself, but it is not free to run. Cloudflare bills each product it uses, and its prices and limits change: check the linked pages before you rely on the figures below, which date from November 2026. Nobody has measured Rondyr on a Workers Free account.

Plan on [Workers Paid](https://developers.cloudflare.com/workers/platform/pricing/), at least $5 a month per account, for three reasons:

- Workers Free allows 10 ms of CPU time per invocation. Signing in hashes the password with scrypt, which is designed to take more CPU than that, and the Worker's start-up adds to every request. Sign-in and other requests can fail on Free.
- Workers Free allows 10,000 queue operations a day. A message takes about 3 operations to reach the classifier and 3 more for each delivery, so a few thousand messages a day use it up, and a spam wave can do it in minutes.
- Cloudflare Email Sending needs Workers Paid.

A trial copy has its own resources and its own usage. A stage with no traffic still runs the Cron every minute: 1,440 Worker invocations a day, each with a few D1 queries and one Durable Object request to record its success. Each message adds a Worker request, a D1 transaction, queue operations, several Durable Object requests, one classifier call, and the same again for each delivery.

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

This list walks through a first installation on a Cloudflare account that has never run Rondyr, with GitHub Actions deploying from your fork. It takes an hour or two, plus the time your domain's zone needs to become active. Copy it into a note, tick each step, and write down what differed from this page: a missing permission, a step in another order, a delay, an error message. Then open an issue or a pull request with your notes, so that the next person does not hit the same problem.

Before you start, write down the date, the commit of Rondyr, and the Cloudflare plan of the account.

### 1. Account, state and API token

- [ ] The account has Workers Paid and your domain as an active zone. Note how long the zone took to become active.
- [ ] Bootstrap the Alchemy state with `pnpm --filter rondyr exec alchemy state bootstrap --backend cloudflare --config alchemy-run.ts`, as in [Alchemy state](#alchemy-state). Note what the command creates in the account and every prompt it shows.
- [ ] Create the API token with exactly the permissions of [API token](#api-token), and nothing more. Keep the list of permissions you had to add during the steps below.
- [ ] In your fork, set the secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `BETTER_AUTH_SECRET_PROD` and `RONDYR_SETUP_TOKEN_PROD`, and the variable `BETTER_AUTH_URL_PROD` (the HTTPS origin on your domain), from [GitHub Actions](#github-actions).

### 2. First deployment

- [ ] Push a commit to `main` of your fork, or start the **Deploy** workflow on `main`. CI runs the checks, deploys `prod`, then waits for `/health`. In the step **Check production health**, note how many tries the new domain needed: each failed try prints one line.
- [ ] Open your origin in a browser and check that the certificate is valid.
- [ ] In the Cloudflare dashboard, check that each resource exists, without any manual step that this page does not describe:
  - [ ] the D1 database, with every migration of `apps/rondyr/database/migrations` applied: in the D1 console, `outbox_events` has the columns `publication_count` and `stuck_at`, and `PRAGMA index_list('outbox_events')` lists `outbox_due_idx` and `outbox_stuck_idx`;
  - [ ] the classification queue and the delivery queue, each with its dead-letter queue, and four consumers on the Worker: one per queue and one per dead-letter queue;
  - [ ] the Cron trigger `* * * * *` on the Worker, and a **Last successful Cron run** on **Status** after the first sign-in;
  - [ ] the Durable Object classes of `apps/rondyr/wrangler.json`, listed under the Worker's bindings;
  - [ ] the Rate Limiting bindings `CLIENT_RATE_LIMIT` and `TARGET_TEST_RATE_LIMIT` under the Worker's bindings. Cloudflare does not show rate limits elsewhere.
- [ ] Check the security headers of the dashboard with the `curl` command of [First deployment](#first-deployment).

### 3. First account and first message

- [ ] Create the first account with `./apps/rondyr/scripts/setup-owner.sh <origin>` ([First account](#first-account)), then sign in.
- [ ] Delete `RONDYR_SETUP_TOKEN_PROD` in GitHub and start the **Deploy** workflow. Check that `POST /api/setup` now answers `404`.
- [ ] Create an organization and a form with a business context, and send a message with `curl` as in the README. Check that it is accepted or quarantined with a reason other than **Analysis unavailable**, within a minute.
- [ ] Check **Status**: the Cron run is recent, and the pending and stuck counts are zero.
- [ ] Create an API token in **Settings → API tokens** and run the [smoke test](./operations.md#smoke-test) with the form's public ID. It prints `Health check and submission classification passed.`

### 4. AI gateway

- [ ] In **AI → AI Gateway**, check that the gateway `default` exists after the first classified message, and that it was created with log collection on. Note whether you had to create it.
- [ ] Open its logs and confirm that no entry holds a message: Rondyr turns log collection off on each call. Note anything that the gateway stored for these calls.

### 5. Optional features, one at a time

For each feature, set its settings, deploy, use the feature, and note what it required beyond this page.

- [ ] Webhooks: set `RONDYR_SECRETS_KEY_PROD` ([Encryption key](#encryption-key)), deploy, add a webhook destination, send a test, and verify a signature with [docs/webhooks.md](./webhooks.md).
- [ ] Email with Resend: set `RESEND_API_KEY_PROD` and `RONDYR_EMAIL_FROM_PROD` ([docs/email.md](./email.md#setup-with-resend)), deploy, add an email destination and send a test.
- [ ] Email with Cloudflare, if the account sends with it: set `RONDYR_EMAIL_PROVIDER_PROD=cloudflare` and the sender ([docs/email.md](./email.md#setup-with-cloudflare-email-sending)), deploy, and send a test.
- [ ] OpenAI Decisions: load credits for [unified billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/), check that the `default` gateway does not require provider credentials, set `RONDYR_CLASSIFIER_PROD=openai`, deploy, and send a message. Note the cost of a message in the credit balance.

### 6. Costs and recovery

- [ ] After a day, note the usage of each product in [Costs and plan limits](#costs-and-plan-limits), and correct the table where it is wrong.
- [ ] Deploy a [trial copy](#trial-copy), and rehearse a D1 restore and a Worker rollback on it with the [operations runbook](./operations.md#restore-d1-with-time-travel). Correct the runbook from what you observe, then remove the trial copy.

For queue diagnosis, recovery, and secret rotation, see the [operations runbook](./operations.md).
