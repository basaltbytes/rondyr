# Inbox and review

The dashboard shows one inbox per organization, with four folders: **To review**, **Accepted**, **Archived** and **All messages**. Each folder has a count, a filter by form, a search in the field values, and pages loaded with a cursor.

![The To review folder: six quarantined messages, each with its reason, and an unsolicited sales pitch open with the Archive and Accept and send buttons](./screenshots/review.webp)

## Review

A quarantined message shows its reason in plain words, such as **Probable spam**, **Unsolicited sales outreach** or **Honeypot field filled**, with the **Archive** and **Accept and send** buttons. Accepting it sends it to the form's destinations, as for a message that the classifier accepted. [Concepts](./concepts.md#decision-rules) lists the reasons and the scores behind them.

Two reviewers who decide on the same message at the same time get one accepted decision and one `409`. A message that the classifier failed on, with the reason **Analysis unavailable**, has a **Reclassify** button that sends it back to the classifier once the model answers again.

A program can read the inbox, accept and archive with an organization API token; see [API tokens and review routes](./api.md).

## Search

The search finds 3 to 100 characters anywhere in the values of the fields, not in their names. It ignores the case of ASCII letters only, so `é` doesn't find `É`. It combines with the folder and the form filter.

## Deliveries

Under the fields of an accepted message, the dashboard lists its deliveries: the destination, the status, and every attempt with its start and end times and its error summary. A failed delivery can be retried by hand; the retry keeps the delivery ID, starts a new series of up to 6 attempts, and two retries at the same time start one attempt. Each webhook and email destination can also receive a test message, marked as a test, without creating a submission or a delivery. [docs/webhooks.md](./webhooks.md#delivery-history-and-manual-retry) has the details.

## Export, deletion and retention

These need the `admin` role.

- **Export this list** downloads the filtered list as CSV or JSON Lines, with the full fields of the 10,000 newest messages at most.
- **Delete this message** deletes a message, its deliveries and their attempts for good, after a confirmation. A log keeps who deleted which message and when, without its content.
- **Retention** sets how many days the organization keeps its accepted messages, and how many it keeps its quarantined and archived ones. Both are empty by default, which keeps messages without limit. A purge runs once an hour, deletes the older messages, and records each deletion in the same log.

A deleted message can't be recovered from the dashboard. D1 Time Travel can still restore the database to an earlier point for 30 days on Workers Paid, which brings deleted rows back, and copies already sent by webhook or email stay with their recipients. [architecture.md](../architecture.md#deletion-and-retention) describes what remains after a deletion.
