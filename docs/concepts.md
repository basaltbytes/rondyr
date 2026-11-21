# Concepts

This page defines the terms that the dashboard and the other pages use, the rules that decide whether a message is accepted, and the path a message takes from the form URL to your webhook or mailbox. [architecture.md](../architecture.md) has the full design.

## Terms

- An **organization** owns forms and an inbox. An account sees only the organizations it is a member of, and its **role** in each one decides what it can do there: a `reviewer` reads and decides on messages, an `admin` can do everything. [Members and invitations](./deployment.md#members-and-invitations) lists the rights of each role.
- A **form** has a public URL, `/f/<public-id>`, and an optional **business context** that describes what the organization does. A form is **active** or **suspended**; a suspended form refuses new submissions and keeps the ones it has.
- A **submission** is one message: a set of text fields sent to a form.
- The **classifier** returns a spam score, a sales outreach score and, when the form has a business context, a relevance score. Each one is between 0 and 1. The outreach score measures whether the sender is trying to sell or pitch something of their own to the organization. A customer asking for a quote, a shop that wants to stock the organization's products, a journalist, or a peer proposing a partnership doesn't count as outreach.
- A **review** is a person's decision on a quarantined submission: accept it, or archive it.
- A **destination** receives the accepted submissions of a form: a **webhook**, or an **email** destination with a list of recipients. Each accepted submission creates one **delivery** per active destination.

## Decision rules

A submission is **accepted** when its spam score is under 0.30, its outreach score is 0.50 or less, and its relevance score, if it has one, is at least 0.50 with Jev or 0.45 with OpenAI Decisions. Otherwise it is **quarantined** with the first reason that applies, in this order: probable spam (0.70 and above), ambiguous, unsolicited sales outreach, low relevance. A failed or incomplete classifier answer gives the reason classifier error. A submission with a filled honeypot field is quarantined with the reason honeypot, and the classifier doesn't score it.

Rondyr never deletes a message on a model's opinion. Probable spam, ambiguous scores, sales pitches, off-topic messages, and classifier failures all go to human review, each with its reason. A classifier outage also sends the message to quarantine instead of losing it; once the model answers again, **Reclassify** sends a message that the classifier failed on back to it.

Jev and OpenAI Decisions both run through Workers AI and the Cloudflare AI Gateway named `default`, with gateway logging off on each call. You choose one classifier per instance, and an organization can ask a second model about ambiguous messages; see [Classifier](./deployment.md#classifier). An admin can change the thresholds and the handling of off-topic messages for the organization in **Settings → Classification**. [docs/evaluation.md](./evaluation.md) has the measurements behind the default thresholds.

## Organization domains

An organization can declare up to ten domains in **Organization domains**. When the submitted email address uses one of these domains or a subdomain, both classifiers are told so and get the email field blank; for any other sender, the classifier input is unchanged.

## Processing

1. Intake checks the form, the body, the allowed origins and the rate limits, then stores the submission and its outbox event in one D1 transaction before it answers `202`.
2. In the background of the same request, Rondyr publishes the event to the classification queue. A cron job runs every minute as the recovery path: it publishes the events whose first publication failed, and republishes any event that wasn't handed to the classifier within 5 minutes. After 12 publications without a hand-off, about an hour, the event is marked stuck: the message stays stored, **Status** lists it, and a member retries it by hand.
3. A durable saga calls the classifier up to three times and resumes after a restart in the middle of a classification. A duplicate queue message produces one decision.
4. An accepted message, automatically or in review, creates one delivery per active destination of its form, queued through the same D1 outbox and cron. Each delivery has a stable ID that the recipient gets on every attempt. A retryable failure is attempted again after 1 minute, 5 minutes, 30 minutes, 2 hours, and 6 hours, then the delivery is marked as failed; a crash between the send and its record leads to a second send with the same ID.

[docs/webhooks.md](./webhooks.md) and [docs/email.md](./email.md) describe the two kinds of destination, and the [operations runbook](./operations.md) covers queue backlogs and stuck processing.

## Isolation and privacy

A session is scoped to its account's organizations, and an API token is scoped to its own organization. Another organization's submission returns `404`.

Rondyr keeps message content in D1, and sends it only in webhook bodies and emails. The event history of a submission contains IDs, scores, and the account or API token that decided, never the fields. The rate limit counters are in Cloudflare's Rate Limiting binding, so Rondyr stores no IP address.
