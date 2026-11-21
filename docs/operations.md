# Operations

## Queue backlog

Open **Status** in the dashboard and select **Refresh**. Check the last successful Cron run, the number of pending outbox events and the age of the oldest one, and the number of stuck events. A pending event is still published by the Cron until the classification consumer hands it off; a stuck event is no longer published, and the pending figures leave it out. The Cron runs every minute and records success after both publishers finish. The timestamp applies to the stage. The other figures apply to each organization your account can see. Quarantine counts group messages received in the past 24 hours that are still in quarantine.

1. If the Cron timestamp is several minutes old, check the Worker’s Cron trigger and scheduled invocation logs in Cloudflare. A `Cron publication failed` entry means the run failed before it could record a success. Check the stage’s D1 and Queue bindings and look for errors at the same time.
2. If the Cron is current but the oldest pending event is older than five minutes and still aging, check the classification queue and its dead-letter queue in **Queues**. Compare backlog, retries, and consumer errors. Use the submission ID in `Direct outbox publication failed` or `Classification queue message requires retry` to inspect `outbox_events`. Compare its lease, publication, and handoff timestamps and its `publication_count`. The Cron republishes expired claims and publications that still lack a handoff after five minutes, up to 12 publications; then the event is stuck (see [Stuck processing](#stuck-processing)).
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

A classifier outage puts messages in **To review** with the reason **Analysis unavailable** (`classification-error`). Check the `AI` binding, `RONDYR_CLASSIFIER`, and the Worker logs of the outage. Once the model answers again, open each message and select **Reclassify**: the message goes back to classification, as if it had just arrived, and leaves **To review** if the filter accepts it. Each reclassification calls the model again, so it uses one slot of the organization's daily classification quota. When the day's quota is used up, Reclassify answers `429` with `{"error":"classification-quota-reached"}`, the dashboard says so, and the message stays in **To review**: try again after midnight UTC, or raise the limit in **Settings → Daily quotas**. Only a message quarantined for this reason can be reclassified; any other reason is the filter’s or intake’s answer, and Reclassify answers `409`. An API token cannot reclassify.

## Production health check

After each deployment, GitHub Actions runs `scripts/smoke.mjs` against `BETTER_AUTH_URL_PROD` in the step **Check production health**. It asks for `/health` every 10 seconds until the Worker answers `ok`, for up to 15 minutes, and prints one line for each failed try, such as `Health check 3 failed: The deployment returned HTTP 522; expected 200 for /health. Trying again.` It never prints a response body.

When the step fails, the run shows the error `Production health`. `prod` is deployed: the failed check does not roll it back.

- `The request or its response failed.` or HTTP `52x` on every try: the domain does not reach the Worker. On a first deployment, check in **Workers & Pages → rondyr-prod → Settings → Domains & Routes** that the custom domain exists and that its certificate is active, and that the zone is active. Run the check again from your machine with `pnpm smoke <origin> --health-timeout 900` once the certificate is active.
- HTTP `404`: the hostname answers but not with Rondyr. Check that `BETTER_AUTH_URL_PROD` is the hostname of the custom domain, and that no other Worker route takes it.
- HTTP `500` or `/health did not report ok.`: the Worker answers but fails. Open its logs in **Workers Logs**, and [roll back](#roll-back-the-worker) if the previous version worked.

## Smoke test

`pnpm smoke` checks a deployment from your machine: `/health`, then, with a form and an API token, that a new submission gets classified. Use it after a deployment, after a [restore](#restore-d1-with-time-travel) or a [rollback](#roll-back-the-worker), or on a [trial copy](./deployment.md#trial-copy). GitHub Actions runs the `/health` part after each deployment.

```sh
pnpm smoke https://forms.example.com
RONDYR_SMOKE_API_TOKEN=<token> pnpm smoke https://forms.example.com --form <public ID>
```

The origin is an HTTPS origin without a path or a port; `http://localhost` also works for local development. `--health-timeout <seconds>` sets how long `/health` may take to answer, 180 seconds by default. The API token comes from `RONDYR_SMOKE_API_TOKEN` only, never from the command line.

The submission check sends one synthetic enquiry about a pottery workshop to the form, reads it back with the API token, and waits up to three minutes for the classifier to accept it or place it in quarantine. A classifier error or a quarantine at intake fails the check. Set it up once:

1. Create an organization for the test and a form with a business context that fits the enquiry, such as a pottery workshop. Add no honeypot field, Turnstile keys, webhook or email destination, so that the test sends no notification and intake does not quarantine it.
2. In **Forms**, copy the form's public ID: the last part of its submission URL, after `/f/`.
3. In **Settings → API tokens** of that organization, create a token named `Smoke test` and copy it. Rondyr shows it once. The token can read and review the inbox of the test organization only.

Each run leaves a message in the test organization and uses one of its daily classifications. The script prints one line and no response body or credential. When it fails:

- `The deployment returned HTTP 401; expected 200 for /api/organizations.`: the API token is unknown or revoked. Create a new one.
- `The form does not belong to the API token's organization.`: `--form` is not the public ID of a form of the token's organization.
- `expected 202 for /f/<form>`: the form refused the submission. Check that it is active and that the organization's daily submission quota is not used up.
- `The smoke submission was not classified within three minutes.`: follow [Queue backlog](#queue-backlog) and [Stuck processing](#stuck-processing).
- `The smoke submission was not classified (classification-error).`: the classifier call failed. Check the `AI` binding, `RONDYR_CLASSIFIER`, and the Worker's logs.
- `The smoke submission was not classified (honeypot).`, `(turnstile-failed)`, `(repetition)` or `(quota)`: intake quarantined the message. Remove the honeypot field or the Turnstile keys from the test form, wait for the repetition window to pass, or raise the organization's daily classification quota.

## Restore D1 with Time Travel

A person with access to the Cloudflare account must carry out and verify the restore and rollback procedures. Nobody has run them on Cloudflare yet, and no automated check covers either operation against a live account. Rehearse them on a [trial copy](./deployment.md#trial-copy) with disposable data, and correct this page from what you observe.

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
- Re-enable the consumers and Cron and restore access once the Worker and D1 schema agree and the affected rows have been reconciled. Check `/health`, sign in, submit a controlled test message, and verify its final inbox state; the [smoke test](#smoke-test) does both with a test form. Check the Cron timestamp and queue backlog again before releasing the incident.

## Rotate secrets

Update the GitHub secret of the deployment (`*_PROD`) and any private environment file you deploy from by hand, such as the one of a trial copy, then deploy.

### `RONDYR_SECRETS_KEY`

Schedule a webhook maintenance window. Inventory the webhook targets and their recipients, retain the previous key with its matching D1 recovery point, and pause delivery consumers while changing keys. Generate a new 32-byte key with `openssl rand -base64 32` and deploy it. Existing signing secrets use the old encryption key. Rotate each target’s signing secret in the dashboard and give the new signing secret to its recipient over a private channel. The old signature cannot participate in the usual rotation overlap once the old encryption key is gone. Verify a test webhook for each recipient, resume the consumers, and retry affected failed deliveries after checking what each recipient already received. Turnstile secret keys are encrypted with the same key, so save the site key and secret key of each form that uses Turnstile again. Until then, intake logs a warning and classifies that form's messages without checking their Turnstile token. The form's Turnstile card in **Forms** shows a warning until the keys are saved again, so you can check that none is left.

### `BETTER_AUTH_SECRET`

Generate a new value with `openssl rand -hex 32`, update the stage secret, and deploy. Expect existing cookies to stop working. Sign out or clear the old cookie, then verify a fresh sign-in and dashboard request. If rotating after a compromise, revoke the stage’s stored sessions as part of the incident response.

### `RESEND_API_KEY`

Create a sending key for the stage’s verified sender domain, update the stage secret, and deploy. Send a test email from the dashboard to a controlled recipient and confirm it in Resend. Revoke the old key once the new one works. If the old key was exposed, revoke it immediately and check delivery history for messages that need a manual retry. [Resend API keys](https://resend.com/docs/dashboard/api-keys/introduction)
