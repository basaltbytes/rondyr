# Deployment

Rondyr runs on your own Cloudflare account, as one Worker with its D1 database, queues, Durable Objects and Workers AI binding. Cloudflare's Git integration, Workers Builds, deploys it from a GitHub or GitLab repository of yours on each push to its `main` branch. You don't need a terminal: the first account is created in the browser.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/basaltbytes/rondyr)

There are two ways to get that repository:

- [The Deploy to Cloudflare button](#deploy-with-the-button) copies Rondyr into your account and deploys it in one go. A copy is not a fork, so getting a later version goes through the [Update Rondyr workflow](#update-a-copy-made-by-the-button).
- [A fork imported into Workers Builds](#fork-and-import) takes a few more clicks the first time. Later versions arrive with GitHub's **Sync fork** button.

Both deploy the same way, from the [Wrangler configuration](../wrangler.json) at the root of the repository. Nobody has run either path on a new account yet: the [fresh account checklist](#fresh-account-checklist) walks through a first installation. If a step differs from what you see, open an issue or a pull request that fixes this page.

## Prerequisites

- A Cloudflare account on Workers Paid. [Costs and plan limits](#costs-and-plan-limits) says why, and what fails on Workers Free.
- A GitHub or GitLab account.

A domain is optional: Rondyr first answers on the `workers.dev` address of the account.

## Deploy with the button

1. Select the button above and sign in to Cloudflare. Connect your GitHub or GitLab account when Cloudflare asks.
2. Check the names on the form: the repository, the Worker (`rondyr`), and the resources that Cloudflare creates. Keep the defaults unless the account already runs a Rondyr.
3. Fill in `RONDYR_SETUP_TOKEN`: a passphrase of at least 32 characters that you choose now, for example with your password manager's generator. Keep it: you enter it once, on the setup page, to create the owner account.
4. Deploy. Cloudflare creates the repository in your account and the resources, then Workers Builds runs `pnpm install`, `pnpm run build` and `pnpm run deploy`. [What a deployment does](#what-a-deployment-does) lists the steps.
5. When the build is done, open the Worker's address, shown in **Workers & Pages → rondyr**, such as `https://rondyr.<your-subdomain>.workers.dev`. Rondyr shows its [setup page](#first-account).

## Fork and import

1. Fork [basaltbytes/rondyr](https://github.com/basaltbytes/rondyr) on GitHub. A fork of a public repository is public; the repository holds no secret.
2. In the Cloudflare dashboard, open **Workers & Pages → Create → Import a repository**, and select the fork. Keep the project name `rondyr`, the root directory `/`, the build command `pnpm run build` and the deploy command `pnpm run deploy`. The Worker's name must be the `name` of `wrangler.json`.
3. Deploy. The first build also creates the D1 database, the queues and the workflow.
4. Open the Worker's address. Rondyr's setup page asks for a setup token, which a fork has not set yet: in **Workers & Pages → rondyr → Settings → Variables and Secrets**, add a secret named `RONDYR_SETUP_TOKEN`, a passphrase of at least 32 characters, then reload the page.

## What a deployment does

Workers Builds runs the root `build` script, then the root `deploy` script, which runs `apps/rondyr/scripts/deploy-cloudflare.mjs` after a build:

1. When the D1 database named in `wrangler.json` doesn't exist, it creates it. The button has already created it; a fork's first build hasn't.
2. It applies the D1 migrations of `apps/rondyr/database/migrations` that the database doesn't have yet, before any new code runs. When a migration fails, nothing is deployed.
3. When the Worker has no `BETTER_AUTH_SECRET` or no `RONDYR_SECRETS_KEY`, it generates them: 32 random bytes each. Nobody sees the values, and a later deployment never replaces a secret that exists. When the Worker's secrets can't be listed, it stops before deploying rather than risk replacing one.
4. It deploys the Worker with `wrangler deploy`, with the secrets it generated in the same version.

The Worker gets:

| Resource | Name in `wrangler.json` |
| --- | --- |
| D1 database, binding `DB` | `rondyr` |
| Classification queue and its dead-letter queue | `rondyr-classification`, `rondyr-classification-dead-letter` |
| Delivery queue and its dead-letter queue | `rondyr-delivery`, `rondyr-delivery-dead-letter` |
| Four queue consumers on the Worker: one per queue, one per dead-letter queue | |
| Durable Object classes of the event streams, the classification runs, the Inbox projection and the Cron heartbeat, with SQLite storage | under `exports` |
| Workflow of the backfill of new Inbox projections | `rondyr-submissions-backfill` |
| Cron trigger, every minute | `* * * * *` |
| Workers AI binding `AI`, for the default classifier | |
| Rate Limiting bindings `CLIENT_RATE_LIMIT` (5 submissions per client and form per minute) and `TARGET_TEST_RATE_LIMIT` (3 test sends per destination per minute) | namespaces `7001` and `7002` |

The build derives the variables that tell the queues apart, such as `CLASSIFICATION_QUEUE_NAME`, from the queue names, so a queue renamed on the button's form keeps working. Each dead-letter consumer logs and acknowledges its messages; see [Dead-letter queues](./operations.md#dead-letter-queues).

A Rate Limiting namespace is shared by every Worker of the account. Two Rondyrs in one account don't share counts: each key starts with the public ID of a form or the ID of a destination. Cloudflare doesn't show rate limits in the dashboard; see [Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/). If the binding doesn't answer, a test send is refused with `503` and `{"error":"test-limit-unavailable"}`.

The configuration turns preview URLs off, so an old version of the Worker never answers on an address of its own with the live data. It keeps the variables set in the dashboard across deployments (`keep_vars`), and Wrangler never deletes a secret. It declares no route: a custom domain is added in the dashboard.

The dashboard assets get their security headers from `apps/rondyr/public/_headers`. After a deployment, check them:

```sh
curl -sI https://forms.example.com/ | grep -iE 'content-security-policy|strict-transport-security|x-frame-options|x-content-type-options|referrer-policy'
```

## First account

Public sign-up is closed. On a new instance, the dashboard shows **Create the owner account**: enter the setup token, then a name, an email address and a password of 12 to 128 characters. Rondyr creates the account and signs it in.

Only someone who knows `RONDYR_SETUP_TOKEN` can do this: the person who filled in the button's form, or someone who can edit the Worker's secrets in the Cloudflare account. Anyone can find the address of a new instance, so being first on the page gives nothing. The Worker compares the token in constant time, refuses a token shorter than 32 characters, and counts the attempts of each client: after 5 in a minute, the next ones answer `429`. D1 refuses a second account through this page, even while the token is still set, and the page then shows the sign-in form. You can delete the secret afterwards.

Without a setup token, or with a shorter one, the page says how to add it in **Workers & Pages → rondyr → Settings → Variables and Secrets**. Saving a secret there deploys it at once.

From a terminal, `./apps/rondyr/scripts/setup-owner.sh <origin>` does the same: it reads `RONDYR_SETUP_TOKEN` from the environment or asks for it, then asks for the account.

The first account creates an organization in the dashboard and is its admin. Any signed-in account can create an organization and becomes its admin.

## Address

Rondyr answers on the address the request came to: the `workers.dev` address of the Worker, and any custom domain you add. Cloudflare routes to a Worker only the hostnames of its account, so a request can't make Rondyr believe it runs somewhere else. The address must be HTTPS on the default port.

To use your own domain, add it in **Workers & Pages → rondyr → Settings → Domains & Routes → Add → Custom domain**. The domain must be a zone of the same account, on Cloudflare's nameservers. Cloudflare creates its DNS record and certificate, which can take a few minutes; `pnpm smoke https://forms.example.com --health-timeout 900` waits for it. Sign in again on the new address: each address has its own session cookie.

To keep one address only, set the variable `BETTER_AUTH_URL` to it, such as `https://forms.example.com`, in **Settings → Variables and Secrets**. Sign-in then refuses the other addresses, and the webhook rules also refuse that host as a destination at delivery time. Without it, a webhook to the Worker's own address is refused only when it is created. Invitation, password reset and recipient confirmation links use the address that the admin was on.

## Settings

Every setting is optional. Set a variable or a secret in **Workers & Pages → rondyr → Settings → Variables and Secrets**; saving it deploys a new version at once, and later deployments keep it.

| Name | Kind | Value |
| --- | --- | --- |
| `RONDYR_SETUP_TOKEN` | Secret | Only while the first account doesn't exist. At least 32 characters |
| `BETTER_AUTH_URL` | Variable | The one address of Rondyr, such as `https://forms.example.com`. See [Address](#address) |
| `RONDYR_CLASSIFIER` | Variable | `jev` (default) or `openai`. See [Classifier](#classifier) |
| `RONDYR_ESCALATION_CLASSIFIER` | Variable | `jev` or `openai` as the second classifier |
| `RONDYR_EMAIL_PROVIDER` | Variable | `resend` (default) or `cloudflare`. See [Email](#email) |
| `RONDYR_EMAIL_FROM` | Variable | A bare sender address on a domain set up with the provider |
| `RESEND_API_KEY` | Secret | A Resend API key with sending access |
| `BETTER_AUTH_SECRET` | Secret | Generated by the first deployment. Signs the sessions |
| `RONDYR_SECRETS_KEY` | Secret | Generated by the first deployment. See [Encryption key](#encryption-key) |

## Updates

Each push to the `main` branch of your repository deploys it, with its migrations. Workers Builds also builds the other branches by default, with the bindings of the Worker, its database included; turn that off in **Settings → Build → Branch control** unless you want it.

### Update a fork

On GitHub, open your fork and select **Sync fork → Update branch**. The push to `main` deploys the new version.

### Update a copy made by the button

1. In your repository on GitHub, open **Actions → Update Rondyr → Run workflow**. Keep `main` for the latest version, or enter a tag.
2. The workflow puts that version on a branch named `update-rondyr/<version>`, and the run's summary gives a link that opens a pull request from that branch into your default branch. The workflow replaces every file with the upstream one except `.github/`, and keeps the names and IDs of your Cloudflare resources in `wrangler.json`, and your `send_email` binding if you added one.
3. Open the pull request from that link and merge it. The push to `main` deploys the new version.

Migrations are forward only and run before the new code. During a deployment, the previous version still runs for a moment against the migrated database, which each migration allows for.

## Trial copy

To try a change without touching your instance, deploy a second one: press the button again with another Worker name and other names for the database, the queues and the workflow. Workflow, queue and database names are unique in an account. If the form doesn't offer one of them, rename it in the second repository's `wrangler.json`. Each copy has its own resources, usage and setup token. Remove a copy by deleting its Worker, D1 database, queues and workflow in the dashboard, then its repository.

## Members and invitations

Every other person joins through an invitation. An admin opens **Settings → Members**, enters an email address and a role, and gets a link of the form `https://<origin>/invitation#<secret>`. The link works once, for 7 days; D1 keeps only the SHA-256 hash of the secret, which sits in the URL fragment so that no request or log carries it. When the instance sends email (see [Email](#email)), Rondyr also emails the link to the address, with fixed text that names neither the organization nor the person who invited. Rondyr emails an address at most 3 invitations in 24 hours across all organizations; past that, and on an instance without email, the admin copies the link from the dashboard and sends it another way.

The invited person opens the link. Without an account, they choose a name and a password of 12 to 128 characters, and the account gets the invited address. With an account at that address, they sign in, then join. A link opened while signed in with another address is refused.

| Role | Rights |
| --- | --- |
| `reviewer` | Reads the inbox and the delivery history, accepts and archives messages |
| `admin` | Everything else as well: forms, allowed origins, honeypot field, Turnstile, destinations, delivery retries and test sends, members, settings, API tokens, export, deletion and retention |

An admin can change a member's role or remove them in the same section. The last admin of an organization can be neither removed nor demoted; the SQL statement that changes the member checks it, so two admins who leave at the same time keep one of them. The same statement checks that the account that asks is still an admin, so a request that started before its author lost the role changes nothing. An admin who changes their own role to reviewer confirms it first, since only another admin can give it back.

Removing a member also revokes the API tokens that this member created in the organization, and cancels the invitations it issued. Before you confirm, the removal dialog says how many active tokens go with the member: a website or a script that uses one of them gets `401` from then on, so give it a token that another admin created first. A demoted admin keeps its tokens, which have the rights of a reviewer anyway, and loses its pending invitations. An invitation only works while the admin who issued it is still an admin of the organization.

The migration that added roles made every member that existed before it an admin. During the deployment, the previous Worker version still runs for a moment after the migration: a member that it adds, the creator of a new organization, gets the column's default, `admin`, the rights it had before roles. An API token acts as a reviewer of its organization.

## Forgotten passwords

On an instance that sends email, the sign-in screen has **Forgot your password?**. Rondyr emails the account a link of the form `https://<origin>/reset-password#<secret>`, valid once for one hour; D1 keeps only the SHA-256 hash of the secret. The screen answers the same whether an account has the address or not, the email leaves after the answer, and an account gets at most 3 links in 24 hours. Choosing a new password signs the account out of every session and marks its address as verified.

This is also how the owner of an address takes back an account that someone else created at it. An admin who opens a copied invitation link instead of sending it can create the account at the invited address without reading that mailbox; the account then belongs to the admin's organization only, and joining another organization takes that organization's own link, which goes to the mailbox. A reset from the mailbox replaces the admin's password and signs the admin out.

On an instance without email, nobody can prove that they read a mailbox: the sign-in screen says that the server can't reset a password, and the person who chose the password keeps the account.

## Classifier

Jev is the default classifier, and the deployed Worker calls it through the Workers AI binding.

To use OpenAI Decisions with GPT-6 Luna instead, set the variable `RONDYR_CLASSIFIER` to `openai` in the Worker's settings. The choice applies to every form of the instance. The Worker calls `openai/decisions` through the `AI` binding and the AI Gateway named `default`. With Cloudflare unified billing, the calls use the account's credits and Rondyr needs no OpenAI key. See the [Decisions model](https://developers.cloudflare.com/ai/models/openai/decisions/) and [unified billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/).

To offer a second opinion for ambiguous submissions, set `RONDYR_ESCALATION_CLASSIFIER` to `openai` when Jev is primary, or to `jev` when OpenAI Decisions is primary. Each organization opts in under **Settings → Classification**; on an instance without a different second classifier, that switch is disabled. The second model only settles the spam score: a submission that the primary model scores as sales outreach, or as off-topic when the organization reviews off-topic submissions, stays in quarantine. An eligible submission can add a model call and its retries to the classification time and cost, and uses one more slot of the organization's daily classification quota. When the quota is used up, the second model isn't called and the submission stays in quarantine as ambiguous.

The deployment doesn't create the `default` gateway. When an account has no gateway with that name, AI Gateway creates it on the first authenticated request, with log collection on; see [Manage gateways](https://developers.cloudflare.com/ai-gateway/configuration/manage-gateway/). Jev calls made with the Workers AI binding go through the same gateway. The Worker turns log collection and caching off on every call of both classifiers, so the submission fields aren't stored in the gateway logs even with the gateway setting on. Logs written before this was in place stay in the gateway until you delete them.

The two classifiers have different default relevance thresholds, measured on a labeled corpus: 0.50 for Jev and 0.45 for OpenAI Decisions. [docs/evaluation.md](./evaluation.md) has the measurements.

## Encryption key

`RONDYR_SECRETS_KEY` is the AES-256-GCM key that encrypts two kinds of secrets in D1: the signing secret of each webhook and the Turnstile secret key of each form. The first deployment generates it, and no later deployment replaces it. Cloudflare never shows a secret again, so this key stays inside the Worker. Without it, the dashboard and the API refuse to create a webhook, rotate its secret, or save a form's Turnstile keys, and everything else works. To use a key of your own, for example to move the instance elsewhere later, set it in the Worker's settings before the first webhook or Turnstile widget, with 32 random bytes in base64:

```sh
openssl rand -base64 32
```

Keep the key once webhooks or Turnstile keys exist. If you remove or change it, every delivery to an existing webhook fails without a retry, because its secret no longer decrypts. To recover with a new key, rotate the secret of each webhook and give the new secret to its recipient. Stored Turnstile secret keys don't decrypt either: intake logs a warning and sends the form's messages to classification without checking their Turnstile token, until you save the form's Turnstile keys again. Until then, the Turnstile card of each of those forms in **Forms** warns that Turnstile isn't protecting it. A value that isn't 32 bytes of base64 counts as missing.

[docs/webhooks.md](./webhooks.md) covers the payload, the signature, and the destination rules.

## Email

Email destinations require `RONDYR_EMAIL_FROM` and the selected provider's key or binding. If a setting is missing, the instance still deploys, creating an email destination answers `503` with `{"error":"email-provider-missing"}`, and a delivery to an existing email destination fails without a retry. When supplied, the sender must be a bare address such as `forms@example.com`.

For Resend, set the secret `RESEND_API_KEY` and the variable `RONDYR_EMAIL_FROM` in the Worker's settings. Use a separate API key for a trial copy.

For Cloudflare Email Sending, onboard the sender domain, then add the binding to `wrangler.json` in your repository, at the top level:

```json
"send_email": [{ "name": "CLOUDFLARE_EMAIL" }],
```

Push it, which deploys, then set the variables `RONDYR_EMAIL_PROVIDER` to `cloudflare` and `RONDYR_EMAIL_FROM` in the Worker's settings. The binding needs no secret; the [Update Rondyr workflow](#update-a-copy-made-by-the-button) keeps it. [Email setup, limits and retries](./email.md#setup-with-cloudflare-email-sending)

For local development with the Cloudflare simulator, set `RONDYR_EMAIL_FROM` in `apps/rondyr/.env` and run `CLOUDFLARE_ENV=cloudflare-email pnpm dev`. The named Wrangler environment enables the binding locally. Cloudflare's local simulator captures emails without delivering them. [Local Email Sending](https://developers.cloudflare.com/email-service/observability/local-development/sending/)

## Costs and plan limits

Rondyr runs on your Cloudflare account and bills nothing itself, but it is not free to run. Cloudflare bills each product it uses, and its prices and limits change: check the linked pages before you rely on the figures below, which date from November 2026. Nobody has measured Rondyr on a Workers Free account.

Rondyr requires [Workers Paid](https://developers.cloudflare.com/workers/platform/pricing/), at least $5 a month per account. On Workers Free, the button and the build still deploy every resource, but these fail:

- Workers Free allows 10 ms of CPU time per invocation. Signing in hashes the password with scrypt, which is designed to take more CPU than that, and the Worker's start-up adds to every request. Creating the owner account and signing in are expected to fail, and other requests can.
- Workers Free allows 10,000 queue operations a day. A message takes about 3 operations to reach the classifier and 3 more for each delivery, so a few thousand messages a day use it up, and a spam wave can do it in minutes.
- Cloudflare Email Sending needs Workers Paid.
- Workers Free has 5 Cron Triggers per account, and Rondyr uses one per instance.

A trial copy has its own resources and its own usage. An instance with no traffic still runs the Cron every minute: 1,440 Worker invocations a day, each with a few D1 queries and one Durable Object request to record its success. Each message adds a Worker request, a D1 transaction, queue operations, several Durable Object requests, one classifier call, and the same again for each delivery.

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
| [Cron Triggers](https://developers.cloudflare.com/workers/platform/limits/) | One per instance | 5 per account | 1,000 per account |
| Email | Email destinations | [Resend](./email.md#resend-limits-and-cost) has its own plans. Cloudflare Email Sending is not available | [Cloudflare Email Sending](./email.md#cloudflare-limits-and-cost): 3,000 emails a month included, then $0.35 per 1,000 |

When a Workers Free limit is reached, Cloudflare refuses the excess until midnight UTC instead of billing it. For Rondyr that means refused submissions (`503` or Cloudflare's own error page), messages quarantined with **Analysis unavailable** when the Workers AI allowance runs out, and messages that wait in a queue. The stored messages are not lost, but nothing alerts you. On Workers Paid, usage over the included amounts is billed. The organization quotas in **Daily quotas** cap stored submissions and classifications per organization; they are the main lever on the classifier's cost. Check usage in the Cloudflare dashboard under **Workers & Pages**, **D1**, **Queues** and **AI**, and set billing notifications on the account.

## Fresh account checklist

This list walks through a first installation with the Deploy to Cloudflare button, on a Cloudflare account that has never run Rondyr. It takes under an hour. Copy it into a note, tick each step, and write down what differed from this page: a field of the form, a permission, a delay, an error message. Then open an issue or a pull request with your notes, so that the next person does not hit the same problem.

Before you start, write down the date, the commit of Rondyr, and the Cloudflare plan of the account.

### 1. Deployment

- [ ] Select the button and note every field of the form: the names it offers to change, and the description of `RONDYR_SETUP_TOKEN`.
- [ ] Note whether the new repository is private, and compare its `wrangler.json` with the upstream one: did the button write IDs or new names into it?
- [ ] In the build log, note the Node.js and pnpm versions, then check that `pnpm install` passes, that every migration of `apps/rondyr/database/migrations` is applied, and that the deployment generates `BETTER_AUTH_SECRET` and `RONDYR_SECRETS_KEY`. Note any permission error.
- [ ] In the Cloudflare dashboard, check that each resource of [What a deployment does](#what-a-deployment-does) exists, without any manual step that this page does not describe:
  - [ ] the D1 database: in its console, `outbox_events` has the columns `publication_count` and `stuck_at`;
  - [ ] the four queues and the four consumers on the Worker;
  - [ ] the Durable Object classes, the workflow, the Cron trigger, the `AI` binding and the two Rate Limiting bindings under the Worker's bindings;
  - [ ] the secrets `BETTER_AUTH_SECRET`, `RONDYR_SECRETS_KEY` and `RONDYR_SETUP_TOKEN`.
- [ ] `https://<worker address>/health` answers `{"status":"ok"}`, and no preview URL of the Worker answers.

### 2. First account and first message

- [ ] `GET /api/setup` answers `{"state":"open"}`. On the setup page, a wrong token is refused; after 5 tries in a minute, the page says to wait.
- [ ] Create the owner account with the right token. The dashboard opens signed in, and `GET /api/setup` answers `{"state":"closed"}`.
- [ ] Create an organization and a form with a business context, and send a message with `curl` as in the README. Check that it is accepted or quarantined with a reason other than **Analysis unavailable**, within a minute.
- [ ] Check **Status**: the Cron run is recent, and the pending and stuck counts are zero.
- [ ] Create an API token in **Settings → API tokens** and run the [smoke test](./operations.md#smoke-test) with the form's public ID. It prints `Health check and submission classification passed.`

### 3. Address and updates

- [ ] Add a custom domain, push a commit, and check that the domain stays attached and that sign-in works on it.
- [ ] Run **Update Rondyr**, merge its branch, and check that the build applies the new migrations, if any.
- [ ] Note what a build of another branch does, and whether it reaches the database.

### 4. AI gateway

- [ ] In **AI → AI Gateway**, check that the gateway `default` exists after the first classified message, and that it was created with log collection on. Note whether you had to create it.
- [ ] Open its logs and confirm that no entry holds a message: Rondyr turns log collection off on each call. Note anything that the gateway stored for these calls.

### 5. Optional features, one at a time

For each feature, set its settings, use the feature, and note what it required beyond this page.

- [ ] Webhooks: add a webhook destination, send a test, and verify a signature with [docs/webhooks.md](./webhooks.md).
- [ ] Email with Resend: set `RESEND_API_KEY` and `RONDYR_EMAIL_FROM` ([docs/email.md](./email.md#setup-with-resend)), add an email destination and send a test.
- [ ] Email with Cloudflare, if the account sends with it ([docs/email.md](./email.md#setup-with-cloudflare-email-sending)): add the binding, set the provider and the sender, and send a test.
- [ ] OpenAI Decisions: load credits for [unified billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/), check that the `default` gateway does not require provider credentials, set `RONDYR_CLASSIFIER` to `openai`, and send a message. Note the cost of a message in the credit balance.

### 6. Costs and recovery

- [ ] After a day, note the usage of each product in [Costs and plan limits](#costs-and-plan-limits), and correct the table where it is wrong.
- [ ] Deploy a [trial copy](#trial-copy), and rehearse a D1 restore and a Worker rollback on it with the [operations runbook](./operations.md#restore-d1-with-time-travel). Correct the runbook from what you observe, then remove the trial copy.

For queue diagnosis, recovery, and secret rotation, see the [operations runbook](./operations.md).

## Maintainers: production on Alchemy

The maintainers' instance, the Worker `rondyr-prod` on a custom domain, predates this deployment and still deploys with [Alchemy](https://alchemy.run) until it moves to the Wrangler deployment above. A push to `main` of `basaltbytes/rondyr` runs the checks, then `.github/workflows/deploy.yml`, which runs `pnpm run deploy:alchemy --stage prod` and checks `/health` for up to 15 minutes. The `scope` job of `ci.yml` (`scripts/deploy-scope.mjs`) skips the deployment when only another package or the documentation changed. Copies of the repository skip it too: their browser tests don't run.

`apps/rondyr/alchemy-run.ts` and `apps/rondyr/src/alchemy-worker.ts` read the root `wrangler.json` for everything they can: compatibility date and flags, assets, Cron, observability, rate limits and queue consumer settings. They name their own resources (`rondyr-prod`, generated queue and database names, the custom domain from `BETTER_AUTH_URL`) and keep their migration history in the `__alchemy_migrations` table. `pnpm doctor` fails when the two definitions drift apart. The workflow reads `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `BETTER_AUTH_SECRET_PROD`, `BETTER_AUTH_URL_PROD` and the optional `*_PROD` versions of the settings above from the repository's secrets and variables. Removing this deployment means deleting `alchemy-run.ts`, `src/alchemy-worker.ts`, `deploy.yml` and the `production` job of `ci.yml` that calls it, the `deploy:alchemy`, `deploy:alchemy:plan` and `dev:alchemy` scripts, the Alchemy branch of `vite.config.ts`, the Alchemy checks of `scripts/doctor.mjs` and this section. The Worker itself keeps `@alchemy.run/domain` and the runtime bridge of `@alchemy.run/cloudflare`.
