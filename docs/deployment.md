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

The stack deploys the Worker with the Vite assets and the Durable Objects of the domain model. It applies the D1 migrations, and it configures the classification and delivery queues, their dead-letter queues and consumers, and the cron trigger that runs every minute. The Worker receives the generated queue names as `CLASSIFICATION_QUEUE_NAME` and `DELIVERY_QUEUE_NAME` to tell the two queues apart.

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

To offer a second opinion for ambiguous submissions, set `RONDYR_ESCALATION_CLASSIFIER=openai` when Jev is primary, or `RONDYR_ESCALATION_CLASSIFIER=jev` when OpenAI Decisions is primary. Each organization opts in under **Settings → Classification**; on a stage without a different second classifier, that switch is disabled. The second model only settles the spam score: a submission that the primary model scores as sales outreach, or as off-topic when the organization reviews off-topic submissions, stays in quarantine. An eligible submission can add a model call and its retries to the classification time and cost.

The stack doesn't create the `default` gateway. When an account has no gateway with that name, AI Gateway creates it on the first authenticated request, with log collection on; see [Manage gateways](https://developers.cloudflare.com/ai-gateway/configuration/manage-gateway/). Jev calls made with the Workers AI binding go through the same gateway. The Worker turns log collection and caching off on every call of both classifiers, so the submission fields aren't stored in the gateway logs even with the gateway setting on. Logs written before this was in place stay in the gateway until you delete them.

Both classifiers use the same thresholds today, although their scores haven't been compared on a test corpus ([#6](https://github.com/basaltbytes/rondyr/issues/6)).

## Encryption key

`RONDYR_SECRETS_KEY` is the AES-256-GCM key that encrypts two kinds of secrets in D1: the signing secret of each webhook and the Turnstile secret key of each form. It is optional. Without it, the dashboard and the API refuse to create a webhook, rotate its secret, or save a form's Turnstile keys, and everything else works. Set it on a stage before its first webhook or Turnstile widget:

```sh
openssl rand -base64 32
```

Add the value to the stage environment file, or to the `RONDYR_SECRETS_KEY_STAGING` or `RONDYR_SECRETS_KEY_PROD` GitHub secret, and redeploy.

Keep the key once webhooks or Turnstile keys exist. If you remove or change it, every delivery to an existing webhook fails without a retry, because its secret no longer decrypts. To recover with a new key, rotate the secret of each webhook and give the new secret to its recipient. Stored Turnstile secret keys don't decrypt either: intake logs a warning and sends the form's messages to classification without checking their Turnstile token, until you save the form's Turnstile keys again. A value that isn't 32 bytes of base64 counts as missing.

[docs/webhooks.md](./webhooks.md) covers the payload, the signature, and the destination rules.

## Email

Email destinations require `RONDYR_EMAIL_FROM` and the selected provider's key or binding. If a setting is missing, the stage still deploys, creating an email destination answers `503` with `{"error":"email-provider-missing"}`, and a delivery to an existing email destination fails without a retry. When supplied, the sender must be a bare address such as `forms@example.com`.

For Resend, set `RESEND_API_KEY` and `RONDYR_EMAIL_FROM` in the stage environment, then redeploy. Use a separate API key per stage. The GitHub workflow reads `RESEND_API_KEY_STAGING` or `RESEND_API_KEY_PROD` from secrets and `RONDYR_EMAIL_FROM_STAGING` or `RONDYR_EMAIL_FROM_PROD` from variables.

For Cloudflare, onboard the sender domain, set `RONDYR_EMAIL_PROVIDER=cloudflare` and `RONDYR_EMAIL_FROM` on the stage, then redeploy. Alchemy adds `CLOUDFLARE_EMAIL` only to the Worker for that stage. In GitHub, set the corresponding `RONDYR_EMAIL_PROVIDER_STAGING` or `RONDYR_EMAIL_PROVIDER_PROD` variable alongside the sender variable. Cloudflare Email Sending uses a native binding and requires no extra secret. [Email setup, limits and retries](./email.md#setup-with-cloudflare-email-sending)

For local development with the Cloudflare simulator, set `RONDYR_EMAIL_FROM` in `.env` and run `CLOUDFLARE_ENV=cloudflare-email pnpm dev`. The named Wrangler environment enables the binding locally. Cloudflare's local simulator captures emails without delivering them. [Local Email Sending](https://developers.cloudflare.com/email-service/observability/local-development/sending/)

## GitHub Actions

Pull requests run `pnpm check` and `pnpm deploy:dry` in one job and the dashboard browser tests (`pnpm test:e2e`) in another. A push to `main`, including a merge, runs the same two jobs and deploys only if both pass. What it deploys depends on the [staging gate](#staging-gate):

- **Gate not configured** (the default): the workflow deploys `prod` and leaves `staging` alone. The run shows the notice `The staging gate is not configured`.
- **Gate configured**: the workflow deploys `staging`, checks `/health` and a submission through the authenticated inbox, and deploys `prod` only if that check passes.

To deploy by hand, start the **Deploy** workflow and choose `staging` (the default) or `prod`. A manual `prod` deployment runs only from `main`. A manual `staging` deployment runs the smoke test when the gate is configured and skips it with a notice otherwise. It never deploys `prod`. Use it for the first setup of staging.

Without `CLOUDFLARE_API_TOKEN`, the workflow skips cloud deployment.

| Name | Kind | Stage |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Secret | Both |
| `BETTER_AUTH_SECRET_PROD`, `BETTER_AUTH_SECRET_STAGING` | Secret | One each |
| `BETTER_AUTH_URL_PROD`, `BETTER_AUTH_URL_STAGING` | Variable | One each |
| `RONDYR_SETUP_TOKEN_PROD`, `RONDYR_SETUP_TOKEN_STAGING` | Secret, optional | One each |
| `RONDYR_SECRETS_KEY_PROD`, `RONDYR_SECRETS_KEY_STAGING` | Secret, optional | One each |
| `RONDYR_CLASSIFIER_PROD`, `RONDYR_CLASSIFIER_STAGING` | Variable, optional | One each |
| `RONDYR_ESCALATION_CLASSIFIER_PROD`, `RONDYR_ESCALATION_CLASSIFIER_STAGING` | Variable, optional | One each |
| `RESEND_API_KEY_PROD`, `RESEND_API_KEY_STAGING` | Secret, optional | One each |
| `RONDYR_EMAIL_FROM_PROD`, `RONDYR_EMAIL_FROM_STAGING` | Variable, optional | One each |
| `RONDYR_EMAIL_PROVIDER_PROD`, `RONDYR_EMAIL_PROVIDER_STAGING` | Variable, optional | One each |
| `RONDYR_SMOKE_ORGANIZATION_ID_STAGING`, `RONDYR_SMOKE_FORM_ID_STAGING` | Variable, optional, [staging gate](#staging-gate) | Staging |
| `RONDYR_SMOKE_EMAIL_STAGING`, `RONDYR_SMOKE_PASSWORD_STAGING` | Secret, optional, [staging gate](#staging-gate) | Staging |

For the Basaltbytes repository, `BETTER_AUTH_URL_PROD` is `https://rondyr.basaltbytes.com`. Delete the setup token secret once the first account exists.

### Staging gate

The gate is configured when all four smoke settings are set in GitHub. With none of them, a push to `main` deploys `prod` directly. With some but not all of them, the push fails before any deployment, and the error names the missing settings, never their values. Set the missing ones, or delete the others to go back to direct deployment.

To turn the gate on, once:

1. Set `BETTER_AUTH_URL_STAGING` to `https://rondyr-staging.<subdomain>.workers.dev` and `BETTER_AUTH_SECRET_STAGING` to a value from `openssl rand -hex 32`. The smoke test refuses any other origin than the `rondyr-staging` `workers.dev` host.
2. Set `RONDYR_SETUP_TOKEN_STAGING` to another value from `openssl rand -hex 32`, then start the **Deploy** workflow with stage `staging`.
3. Create the staging account. The script asks for the setup token from step 2, then for a name, an email address and a password. Use an email address and a password that serve only on staging. The script creates only the first account of a stage: if staging already has one, use it only if no person relies on it.

   ```sh
   ./scripts/setup-owner.sh https://rondyr-staging.<subdomain>.workers.dev
   ```

4. Sign in at the staging origin. Create an organization and its first form with **Create organization**. A pottery workshop is suitable business context for the synthetic enquiry. Leave the form active and add no webhook or email destination, so that the test sends no notification.
5. While signed in, open `/api/organizations` on the staging origin. Note the organization’s `id` and the form’s `publicId`.
6. In the repository settings, set the variables `RONDYR_SMOKE_ORGANIZATION_ID_STAGING` (the `id`) and `RONDYR_SMOKE_FORM_ID_STAGING` (the `publicId`), and the secrets `RONDYR_SMOKE_EMAIL_STAGING` and `RONDYR_SMOKE_PASSWORD_STAGING` (the account from step 3). Set all four before the next push to `main`: a push that finds only some of them fails.
7. Delete `RONDYR_SETUP_TOKEN_STAGING`, then start the **Deploy** workflow with stage `staging` again. The run deploys staging and runs the smoke test. When it passes, the next push to `main` goes through the gate.

The smoke test signs in, submits one synthetic message, checks the stored message, and waits up to three minutes for the normal classifier to accept it or place it in quarantine. A classifier error or a quarantine at intake fails the check. Keep the test form separate from forms used by people. Each run leaves a message in staging.

When the gate fails, the job `staging / Deploy staging` of the CI run is red, `production` is skipped, and production keeps its previous version. The step **Verify staging health and submission processing** prints one line, for example `Staging returned HTTP 401; expected 200 for /api/auth` or `Staging did not classify the smoke submission within three minutes.`, and never a response body or credential. A partial configuration fails the job **Staging gate configuration** instead, before any deployment. Fix staging or the settings, then push again or re-run the failed jobs. See [the runbook](./operations.md#staging-gate) for the diagnosis.

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

For queue diagnosis, recovery, and secret rotation, see the [operations runbook](./operations.md).
