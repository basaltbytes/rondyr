# Operations

## Queue backlog

Open **Status** in the dashboard and select **Refresh**. Check the last successful Cron run, the number of undelivered outbox events, the age of the oldest one, and the number of stuck events. The Cron runs every minute and records success after both publishers finish. The timestamp applies to the stage. The other figures apply to each organization your account can see. Quarantine counts group messages received in the past 24 hours that are still in quarantine.

1. If the Cron timestamp is several minutes old, check the Worker’s Cron trigger and scheduled invocation logs in Cloudflare. A `Cron publication failed` entry means the run failed before it could record a success. Check the stage’s D1 and Queue bindings and look for errors at the same time.
2. If the Cron is current but the oldest undelivered event is older than five minutes and still aging, check the classification queue and its dead-letter queue in **Queues**. Compare backlog, retries, and consumer errors. Use the submission ID in `Direct outbox publication failed` or `Classification queue message requires retry` to inspect `outbox_events`. Compare its lease, publication, and handoff timestamps and its `publication_count`. The Cron republishes expired claims and publications that still lack a handoff after five minutes, up to 12 publications; then the event is stuck (see [Stuck processing](#stuck-processing)).
3. For a delivery backlog, inspect the delivery queue and its dead-letter queue. Compare `pending`, `processing`, and `retrying` counts over time. Open the affected delivery’s history for its next attempt and provider result. Once the provider or configuration is fixed, use the dashboard to retry a `failed` delivery. The recipient may receive a duplicate with the same delivery ID.
4. After a fix, refresh **Status** and check that the oldest backlog age and count fall. Use the [Cloudflare Queues dashboard](https://developers.cloudflare.com/queues/observability/metrics/) to inspect queue metrics.

The Worker’s application logs use operation names, identifiers, status tags, and durations. Keep message fields and credentials out of incident notes and shared log exports.

## Stuck processing

The Cron publishes the event of a new submission until the classification consumer hands it to the domain model. After 12 publications without a hand-off, about an hour, the Cron marks the event as stuck and stops publishing it. The submission and its fields stay in D1; nothing is lost. The submission shows as received in the inbox, and stuck on the **Status** page.

To find stuck submissions:

- On **Status**, the **Stuck** figure of each organization, and under it the list of stuck submissions, oldest first: form, arrival time and submission ID, without the message.
- `GET /api/organizations/:organizationId/stuck-submissions` with a dashboard session, which returns the same list.
- In **Workers Logs** of the stage’s Worker, the error `Outbox event stuck`, logged once per event with its submission ID.

To find the cause, search the Worker logs for the submission ID:

- `Queue message dead-lettered` with `queue: "classification"`: the consumer failed three times on the message. Each failure logs `Classification queue message requires retry` with an error tag. `StorageUnavailable` points to D1. A `SchemaError` usually means that the row holds a value this version of the Worker does not know, such as an intake reason written by a newer version before a rollback.
- No consumer log at all: check that the classification queue has a consumer in **Queues**, and that `CLASSIFICATION_QUEUE_NAME` is set on the Worker.
- Errors from the `SubmissionAggregate` Durable Object: the hand-off to the domain model failed.

Once the cause is fixed, select **Retry** next to each stuck submission. Retry sets the publication count back to zero and publishes the event at once; the list and the figures refresh. If the same submission is stuck again an hour later, the cause is still there. Retry answers `409` for a submission that is no longer stuck, for example after a hand-off by a late queue message.

### Dead-letter queues

Each queue has a dead-letter queue with its own consumer. The consumer logs `Queue message dead-lettered` at error level with the queue (`classification` or `delivery`), the queue message ID, the number of attempts, and the submission or delivery ID, then acknowledges the message. D1 keeps the state, so nothing needs to be replayed from a dead-letter queue: the Cron republishes a classification event until it is stuck, and a delivery stays `retrying`, `processing` or `failed` in D1, where the dashboard can retry it. A message that does not decode is logged with its queue message ID only. The same submission or delivery ID can appear more than once: Queues delivers at least once.

### Messages that the filter could not analyze

A classifier outage puts messages in **To review** with the reason **Analysis unavailable** (`classification-error`). Check the `AI` binding, `RONDYR_CLASSIFIER`, and the Worker logs of the outage. Once the model answers again, open each message and select **Reclassify**: the message goes back to classification, as if it had just arrived, and leaves **To review** if the filter accepts it. Reclassify uses the classification slot that the message took at intake, not a new one. Only a message quarantined for this reason can be reclassified; any other reason is the filter’s or intake’s answer, and Reclassify answers `409`. An API token cannot reclassify.

## Staging gate

A push to `main` deploys `prod` in one of two modes. Check the summary of the CI run to see which one applied.

- **Staging not configured**: the run shows the notice `Staging is not configured`, deploys `prod`, and leaves `staging` untouched. Nothing tests the release before production.
- **Staging configured**: the run deploys `staging`, runs `scripts/smoke-staging.mjs` against it, and deploys `prod` only if the script passes. The script checks `/health`, then, when the [submission check](./deployment.md#submission-check) is set up, the classification of one test submission. Without the submission check, the run shows the notice `Staging is deployed and its /health checked before prod, without a test submission`.

[Staging gate](./deployment.md#staging-gate) in the deployment guide lists the setup.

### When the gate fails

The job `staging / Deploy staging` is red and `production` is skipped. Production keeps the version it had before the push. Open the failed step:

- The gate job **Staging gate configuration** with `Staging is partly configured` or `The staging submission check is partly configured`: nothing was deployed. Set the setting it names, or delete the other one of the pair.
- **Check deployment configuration** with `The staging submission check is partly configured`: a smoke setting was deleted after the run started. Restore it or delete the other one.
- **Deploy through Alchemy**: staging itself did not deploy. Read the Alchemy output, and run `pnpm deploy:plan --stage staging` with the staging environment to see the drift.
- **Verify staging health and submission processing**: staging deployed but did not pass the test. The step prints one line and no response body:
  - `Staging returned HTTP <status>; expected 200 for /health` or `Staging health did not report ok.`: the script tried four times over 15 seconds. Check the Worker's logs and its D1 binding on staging.
  - `Staging returned HTTP 401; expected 200 for /api/organizations`: the API token is unknown or revoked. Create a new one in **Settings → API tokens** of the test organization and update `RONDYR_SMOKE_API_TOKEN_STAGING`.
  - `The smoke form does not belong to the API token's organization.`: `RONDYR_SMOKE_FORM_ID_STAGING` is not the public ID of a form of the token's organization.
  - `expected 202 for /f/<form>`: the form refused the submission. Check that the form is still active.
  - `Staging did not classify the smoke submission within three minutes.`: follow [Queue backlog](#queue-backlog) and [Stuck processing](#stuck-processing) on staging.
  - `Staging did not classify the smoke submission (classification-error).`: the classifier call failed. Check the `AI` binding, the `RONDYR_CLASSIFIER_STAGING` value, and the Worker's logs.
  - `Staging did not classify the smoke submission (honeypot).`: the test form's honeypot field is `name` or `message`, which the test fills. Remove the honeypot field from the test form or rename it.
  - `The smoke test requires the rondyr-staging workers.dev origin.`: `BETTER_AUTH_URL_STAGING` is not the staging `workers.dev` origin. The test refuses any other host.

Once staging is fixed, re-run the failed jobs of the CI run, or push again. To ship a fix to production while staging stays broken, delete `BETTER_AUTH_URL_STAGING` and the two smoke settings: the next push deploys `prod` directly, with the notice. Restore them once staging works. Keep `BETTER_AUTH_SECRET_STAGING`: staging sessions depend on it.

## Restore D1 with Time Travel

A Cloudflare operator must carry out and verify the restore and rollback procedures. Nobody has run them on Cloudflare yet, and no automated check covers either operation against a live account. Rehearse them on staging with disposable data, and correct this page from what you observe.

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

A version older than the stuck processing change (the `stuck-outbox-events` migration) ignores `stuck_at`, so it publishes stuck events again every five minutes, and it routes dead-letter batches to the classification consumer. It also does not know the `ReclassificationRequested` event, so the consumers of a reclassified submission's event stream can fail on it until the newer version is back. Prefer a forward fix to a rollback across that change.

## Reconcile after recovery

D1 Time Travel rewinds D1 alone. Durable Object event streams and workflow state, queue messages, and Alchemy state stay at their current positions. Worker rollback changes the active version, including its code, assets, and versioned bindings. The data and Alchemy state keep their current positions in that case too.

- After a D1 restore, the outbox is back at the recovery point: publication counts, stuck marks and hand-offs recorded later are gone. The Cron publishes again the events that lost their hand-off; the consumer sends the same command ID, which the aggregate already knows, and records the hand-off again. Stuck submissions that were retried after the recovery point are stuck again: retry them from **Status**.
- The Inbox projection keeps its own position in its Durable Object. Inbox rows written after the recovery point are gone from D1, and the projection does not write them again: those messages show an older status, or `received`, until their next event. Rebuilding a projection with the Alchemy Domain tooling has not been tried on Rondyr; record the affected submission IDs before attempting it.
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
