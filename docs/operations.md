# Operations

## Queue backlog

Open **Status** in the dashboard and select **Refresh**. Check the last successful Cron run, the number of unhanded outbox events, and the age of the oldest one. The Cron runs every minute and records success after both publishers finish. The timestamp applies to the stage. The other figures apply to each organization your account can see. Quarantine counts group messages received in the past 24 hours that are still in quarantine.

1. If the Cron timestamp is several minutes old, check the Worker’s Cron trigger and scheduled invocation logs in Cloudflare. A `Cron publication failed` entry means the run failed before it could record a success. Check the stage’s D1 and Queue bindings and look for errors at the same time.
2. If the Cron is current but the oldest unhanded event is older than five minutes and still aging, check the classification queue and its dead-letter queue in **Queues**. Compare backlog, retries, and consumer errors. Use the submission ID in `Direct outbox publication failed` to inspect `outbox_events`. Compare its lease, publication, and handoff timestamps. The Cron republishes expired claims and publications that still lack a handoff after five minutes.
3. For a delivery backlog, inspect the delivery queue and its dead-letter queue. Compare `pending`, `processing`, and `retrying` counts over time. Open the affected delivery’s history for its next attempt and provider result. Once the provider or configuration is fixed, use the dashboard to retry a `failed` delivery. The recipient may receive a duplicate with the same delivery ID.
4. After a fix, refresh **Status** and check that the oldest backlog age and count fall. Keep the dead-letter messages while investigating. Record the submission or delivery IDs and check whether the consumer has already handled them before arranging a replay. Use the [Cloudflare Queues dashboard](https://developers.cloudflare.com/queues/observability/metrics/) to inspect queue metrics.

The Worker’s application logs use operation names, identifiers, status tags, and durations. Keep message fields and credentials out of incident notes and shared log exports.

## Staging gate

A push to `main` deploys `prod` in one of two modes. Check the summary of the CI run to see which one applied.

- **Gate not configured**: the run shows the notice `The staging gate is not configured`, deploys `prod`, and leaves `staging` untouched. Nothing tests the release before production. This is the default until someone sets the gate up.
- **Gate configured**: the run deploys `staging`, runs `scripts/smoke-staging.mjs` against it, and deploys `prod` only if the test passes.

[Staging gate](./deployment.md#staging-gate) in the deployment guide lists the one-time setup: the staging account created with `scripts/setup-owner.sh`, an organization and a form with no destinations, then two variables and two secrets in GitHub.

### When the gate fails

The job `staging / Deploy staging` is red and `production` is skipped. Production keeps the version it had before the push. Open the failed step:

- **Check deployment configuration** with `The staging smoke test is required but these settings are missing`: a smoke setting was deleted after the run started. Restore it or delete the other three.
- The gate job **Staging gate configuration** with `The staging gate is partly configured`: nothing was deployed. Set the settings it names, or delete the others to deploy `prod` without the gate.
- **Deploy through Alchemy**: staging itself did not deploy. Read the Alchemy output, and run `pnpm deploy:plan --stage staging` with the staging environment to see the drift.
- **Verify staging health and submission processing**: staging deployed but did not pass the test. The step prints one line and no response body:
  - `Staging returned HTTP <status>; expected 200 for /health` or `Staging health did not report ok.`: check the Worker’s logs and its D1 binding on staging.
  - `expected 200 for /api/auth`: the sign-in failed. Check that the smoke secrets match the staging account, and that `BETTER_AUTH_SECRET_STAGING` has not changed since the account signed in.
  - `expected 202 for /f/<form>`: the form refused the submission. Check that the form is still active and that its ID matches `RONDYR_SMOKE_FORM_ID_STAGING`.
  - `expected 200 for /api/organizations`: the account cannot read the submission. Check `RONDYR_SMOKE_ORGANIZATION_ID_STAGING` and the account’s membership.
  - `Staging did not classify the smoke submission within three minutes.`: follow [Queue backlog](#queue-backlog) on staging.
  - `Staging did not classify the smoke submission (classification-error).`: the classifier call failed. Check the `AI` binding, the `RONDYR_CLASSIFIER_STAGING` value, and the Worker’s logs.
  - `Staging did not classify the smoke submission (honeypot).`: the test form’s honeypot field is `name` or `message`, which the test fills. Remove the honeypot field from the test form or rename it.
  - `The smoke test requires the rondyr-staging workers.dev origin.`: `BETTER_AUTH_URL_STAGING` is not the staging `workers.dev` origin. The test refuses any other host.

Once staging is fixed, re-run the failed jobs of the CI run, or push again. To ship a fix to production while staging stays broken, delete the four smoke settings: the next push deploys `prod` directly, with the notice. Restore them once staging works.

## Restore D1 with Time Travel

A Cloudflare operator must carry out and verify the restore and rollback procedures. Rehearse them on staging with disposable data. Automated checks cover neither operation against a live Cloudflare account.

1. Confirm the account, stage, Worker, and actual D1 database name in the Worker’s binding or Alchemy stack output. `rondyr-local` is the development database name. Find the first bad write or migration and determine the UTC recovery point.
2. Stop push-triggered deployments and arrange a maintenance window. Stop public intake and dashboard writes at the stage origin. Pause delivery on both queues, disable the Cron trigger, and account for in-flight consumers and Durable Object workflows before restoring. Keep the queues and dead-letter queues for reconciliation.
3. Export the current database into restricted backup storage and record its current bookmark. Look up the target bookmark and have the incident operator confirm the database and recovery point. A restore overwrites the database in place, including any later submissions, auth changes, and schema migrations.

   ```sh
   pnpm exec wrangler d1 export "$RONDYR_D1_NAME" --remote --output "$RONDYR_INCIDENT_BACKUP"
   pnpm exec wrangler d1 time-travel info "$RONDYR_D1_NAME"
   pnpm exec wrangler d1 time-travel info "$RONDYR_D1_NAME" --timestamp "$RONDYR_RECOVERY_UTC"
   pnpm exec wrangler d1 time-travel restore "$RONDYR_D1_NAME" --bookmark "$RONDYR_RECOVERY_BOOKMARK"
   ```

4. Follow [Reconcile after recovery](#reconcile-after-recovery) before resuming traffic. Keep the pre-restore bookmark and backup until the incident is resolved. Cloudflare documents the 30-day window and how to return to the pre-restore bookmark. [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)

## Roll back the Worker

1. Pause deployments. In **Workers & Pages**, select the stage’s Worker and open **Deployments**. Record the current version and select the last good version. Compare bindings, D1 schema compatibility, Durable Object migrations, and the secrets the old version would use before routing traffic to it.
2. Use **Rollback** on that version, or run `pnpm exec wrangler rollback "$RONDYR_WORKER_VERSION" --name "rondyr-$RONDYR_STAGE"`. If Cloudflare rejects the rollback across a Durable Object migration or a removed binding, prepare a forward fix with the required bindings and classes. Preserve the Durable Object namespaces and their data. [Cloudflare Worker rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
3. Confirm the active version and `/health`. Sign in and check the dashboard. Follow the reconciliation steps below before resuming normal deployments.

## Reconcile after recovery

D1 Time Travel rewinds D1 alone. Durable Object event streams and workflow state, queue messages, and Alchemy state stay at their current positions. Worker rollback changes the active version, including its code, assets, and versioned bindings. The data and Alchemy state keep their current positions in that case too.

- Compare the backup and restored database for submissions, outbox handoffs, inbox versions, delivery attempts, and the applied D1 migrations. Account for every submission after the recovery point. Restore missing rows from the backup under operator control, keeping their original IDs and preserving the submission and its outbox event together. Check each affected inbox projection against its Durable Object events. A previously recorded command ID can make replay a no-op. Rebuild affected projections only from verified events, and check provider records before retrying deliveries that might already have gone out.
- Compare the active Worker and D1 schema to the intended Git revision. Run `pnpm deploy:plan --stage "$RONDYR_STAGE"` with the authorized profile and the stage environment before the next Alchemy deployment. Review any drift or migration that the plan proposes. Cloudflare’s manual rollback leaves the Alchemy inventory at its previous revision.
- Re-enable the consumers and Cron and restore access once the Worker and D1 schema agree and the affected rows have been reconciled. Check `/health`, sign in, submit a controlled test message, and verify its final inbox state. Check the Cron timestamp and queue backlog again before releasing the incident.

## Rotate secrets

Use the secret store for the affected stage. Update the corresponding GitHub secret and any private local deployment environment used for that stage. When the [staging gate](#staging-gate) is configured, a push to `main` deploys staging first, so rotate the staging secret before the production one.

### `RONDYR_SECRETS_KEY`

Schedule a webhook maintenance window. Inventory the webhook targets and their recipients, retain the previous key with its matching D1 recovery point, and pause delivery consumers while changing keys. Generate a new 32-byte key with `openssl rand -base64 32` and deploy it. Existing signing secrets use the old encryption key. Rotate each target’s signing secret in the dashboard and give the new signing secret to its recipient over a private channel. The old signature cannot participate in the usual rotation overlap once the old encryption key is gone. Verify a test webhook for each recipient, resume the consumers, and retry affected failed deliveries after checking what each recipient already received. Turnstile secret keys are encrypted with the same key, so save the site key and secret key of each form that uses Turnstile again. Until then, intake logs a warning and classifies that form's messages without checking their Turnstile token. The form's Turnstile card in **Forms** shows a warning until the keys are saved again, so you can check that none is left.

### `BETTER_AUTH_SECRET`

Generate a new value with `openssl rand -hex 32`, update the stage secret, and deploy. Expect existing cookies to stop working. Sign out or clear the old cookie, then verify a fresh sign-in and dashboard request. If rotating after a compromise, revoke the stage’s stored sessions as part of the incident response. Keep the staging smoke account credentials current if you also change its password.

### `RESEND_API_KEY`

Create a sending key for the stage’s verified sender domain, update the stage secret, and deploy. Send a test email from the dashboard to a controlled recipient and confirm it in Resend. Revoke the old key once the new one works. If the old key was exposed, revoke it immediately and check delivery history for messages that need a manual retry. [Resend API keys](https://resend.com/docs/dashboard/api-keys/introduction)
