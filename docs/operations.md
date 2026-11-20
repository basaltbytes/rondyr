# Operations

## Queue backlog

Open **État** in the dashboard and select **Actualiser**. Check the last successful Cron run, the number of unhanded outbox events, and the age of the oldest one. The Cron runs every minute and records success after both publishers finish. The timestamp applies to the stage. The other figures apply to each organization your account can see. Quarantine counts group messages received in the past 24 hours that are still in quarantine.

1. If the Cron timestamp is several minutes old, check the Worker’s Cron trigger and scheduled invocation logs in Cloudflare. A `Cron publication failed` entry means the run failed before it could record a success. Check the stage’s D1 and Queue bindings and look for errors at the same time.
2. If the Cron is current but the oldest unhanded event is older than five minutes and still aging, check the classification queue and its dead-letter queue in **Queues**. Compare backlog, retries, and consumer errors. Use the submission ID in `Direct outbox publication failed` to inspect `outbox_events`. Compare its lease, publication, and handoff timestamps. The Cron republishes expired claims and publications that still lack a handoff after five minutes.
3. For a delivery backlog, inspect the delivery queue and its dead-letter queue. Compare `pending`, `processing`, and `retrying` counts over time. Open the affected delivery’s history for its next attempt and provider result. Once the provider or configuration is fixed, use the dashboard to retry a `failed` delivery. The recipient may receive a duplicate with the same delivery ID.
4. After a fix, refresh **État** and check that the oldest backlog age and count fall. Keep the dead-letter messages while investigating. Record the submission or delivery IDs and check whether the consumer has already handled them before arranging a replay. Use the [Cloudflare Queues dashboard](https://developers.cloudflare.com/queues/observability/metrics/) to inspect queue metrics.

The Worker’s application logs use operation names, identifiers, status tags, and durations. Keep message fields and credentials out of incident notes and shared log exports.

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

Use the secret store for the affected stage. Update the corresponding GitHub secret and any private local deployment environment used for that stage. The production deployment runs through the [staging gate](./deployment.md#github-actions).

### `RONDYR_SECRETS_KEY`

Schedule a webhook maintenance window. Inventory the webhook targets and their recipients, retain the previous key with its matching D1 recovery point, and pause delivery consumers while changing keys. Generate a new 32-byte key with `openssl rand -base64 32` and deploy it. Existing signing secrets use the old encryption key. Rotate each target’s signing secret in the dashboard and give the new signing secret to its recipient over a private channel. The old signature cannot participate in the usual rotation overlap once the old encryption key is gone. Verify a test webhook for each recipient, resume the consumers, and retry affected failed deliveries after checking what each recipient already received.

### `BETTER_AUTH_SECRET`

Generate a new value with `openssl rand -hex 32`, update the stage secret, and deploy. Expect existing cookies to stop working. Sign out or clear the old cookie, then verify a fresh sign-in and dashboard request. If rotating after a compromise, revoke the stage’s stored sessions as part of the incident response. Keep the staging smoke account credentials current if you also change its password.

### `RESEND_API_KEY`

Create a sending key for the stage’s verified sender domain, update the stage secret, and deploy. Send a test email from the dashboard to a controlled recipient and confirm it in Resend. Revoke the old key once the new one works. If the old key was exposed, revoke it immediately and check delivery history for messages that need a manual retry. [Resend API keys](https://resend.com/docs/dashboard/api-keys/introduction)
