# Email

When a message is accepted, automatically or in review, Rondyr sends it as one plain text email to the recipients of each active email destination of its form. The email goes out through the email provider of the stage. [Resend](https://resend.com) is the only provider so far; an adapter for Cloudflare's email service is planned in a separate issue.

As with webhooks, a quarantined message is sent only once someone accepts it, and a destination created or reactivated after a message was accepted doesn't receive that message.

## Setup with Resend

You need a Resend account, a domain you control, and access to its DNS records.

1. In Resend, add the domain you will send from. Resend recommends a subdomain such as `notifications.example.com` rather than the root domain, so that the reputation of these emails stays apart from your other mail. See [Domains](https://resend.com/docs/dashboard/domains/introduction).
2. Add the DNS records that Resend shows for the domain: SPF and DKIM, as `TXT`, `MX` or `CNAME` records. Copy them exactly. If the zone is on Cloudflare, don't proxy them. Verification often completes within 15 minutes, and DNS changes can take up to 72 hours. See [Add a domain](https://resend.com/docs/add-a-domain).
3. Create an API key with **Sending access**, restricted to that domain. Resend shows the value only once. See [API keys](https://resend.com/docs/dashboard/api-keys/introduction).
4. Set both values in the stage environment, then redeploy:

| Variable | Kind | Value |
| --- | --- | --- |
| `RESEND_API_KEY` | Secret | The API key, `re_…` |
| `RONDYR_EMAIL_FROM` | Setting | A bare address on the verified domain, such as `forms@notifications.example.com` |
| `RONDYR_EMAIL_PROVIDER` | Setting, optional | `resend`, the default and only value |

The deployment refuses a `RONDYR_EMAIL_FROM` that isn't a bare address: `Rondyr <forms@example.com>` is refused. [deployment.md](./deployment.md#email) lists the matching GitHub secrets and variables.

Both values are optional. Without one of them the stage deploys and works as before: listing email destinations still works, creating one answers `503` with `{"error":"email-provider-missing"}`, and a delivery to an email destination created earlier fails without a retry, with the summary `Email is not configured on this stage. Set RESEND_API_KEY and RONDYR_EMAIL_FROM, then redeploy.`

## Limits and cost

Resend's prices and limits change; check [Pricing](https://resend.com/pricing) and [Account quotas and limits](https://resend.com/docs/knowledge-base/account-quotas-and-limits) before you rely on them. In November 2026 they were:

- The free plan sends 3,000 emails a month and 100 a day, from up to 3 domains. The daily quota resets at midnight UTC.
- Paid plans start at $20 a month for 50,000 emails, with no daily limit, and bill extra emails in blocks of 1,000.
- Each recipient counts as one email. A destination with 4 recipients uses 4 emails per accepted message.
- The API accepts 10 requests per second per team. See [Rate limit](https://resend.com/docs/api-reference/rate-limit).
- Resend expects a bounce rate under 4% and a spam complaint rate under 0.08%.

A message over quota or over the rate limit gets `429`, which Rondyr retries. A daily quota reached in the afternoon resets at midnight UTC, which can be after the last retry (about 8 and a half hours after the first attempt), so these messages can end up failed. They stay in the inbox either way.

## Destinations

In the dashboard, open **E-mails** under the inbox, enter the recipients next to the form, one per line, and click **Ajouter**. **Modifier les destinataires** replaces the list, and **Désactiver** stops deliveries for messages accepted from then on.

A destination has 1 to 10 recipients. Each one is a bare ASCII address such as `team@example.com`. Rondyr refuses a display name (`Team <team@example.com>`), several addresses in one entry, spaces, line breaks, an internationalized address, and the same address twice, ignoring case.

The dashboard calls these routes, which need a session cookie and the `Origin` of the Worker:

| Route | Effect |
| --- | --- |
| `GET /api/organizations/:organizationId/forms/:publicId/targets` | Lists the form's webhooks and email destinations, each with its `type` |
| `POST /api/organizations/:organizationId/forms/:publicId/targets` | Creates an email destination from `{"type":"email","recipients":["team@example.com"]}` (`201`) |
| `PUT /api/organizations/:organizationId/targets/:targetId/recipients` | Replaces the recipients from `{"recipients":[…]}` |
| `POST /api/organizations/:organizationId/targets/:targetId/deactivate` or `/activate` | Returns the destination with its new state |

A refused list answers `400` with `{"error":"recipients-refused","reason":…}`, where the reason is `no-recipients`, `too-many-recipients`, `invalid-address` or `duplicate-address`. A form or destination of an organization the account isn't a member of answers `404`.

## Message

The email is plain text, with no HTML, and its text is in French for now. For a form named `Classes`:

```text
From: forms@notifications.example.com
To: team@example.com
Reply-To: customer@example.com
Subject: Nouveau message : Classes

Nouveau message reçu par le formulaire « Classes ».

email :
customer@example.com

message :
Is there room in the pottery class?

-- 
Formulaire : Classes
Reçu le : 20 novembre 2026 à 14:03:00 UTC
Identifiant de livraison : 0f6c1a62-6b8e-4c43-9f5e-2d3a9b7c4e11

Rondyr peut envoyer deux fois la même livraison. Deux messages qui portent le même identifiant de livraison sont des doublons.
```

The body lists every field in the order the form sent them, then the form name, the time of reception in UTC, and the delivery ID.

Field names and values come from visitors, so none of them goes into a header, with one exception. When the submission has a field named exactly `email` whose value is a single valid address, with no display name, no space and no line break, it becomes the `Reply-To` address, and answering the email writes to the visitor. Any other value, such as `visitor@example.com` followed by a line break, leaves the email without `Reply-To`. The subject is built from the form name only. In the body, line breaks inside a field name become spaces, and line breaks inside a value become plain `\n`.

## Responses and retries

Rondyr sends each attempt with the delivery ID as Resend's [idempotency key](https://resend.com/docs/dashboard/emails/idempotency-keys). Resend keeps a key for 24 hours and answers a repeated request with the same response, without sending the email again. All six attempts of a delivery fall within that window.

From the response, Rondyr keeps the status code and the error code, such as `validation_error`. It never stores Resend's error message, which can repeat a field of the request. The codes are those of [Resend's error reference](https://resend.com/docs/api-reference/errors).

| Response | Result |
| --- | --- |
| `2xx` | Delivered |
| `429`: rate limit, daily or monthly quota | Retried |
| `5xx` | Retried |
| `409 concurrent_idempotent_requests`: an earlier attempt is still running at Resend | Retried |
| No response, a network error, or no answer within 30 seconds | Retried |
| Any other status: `400`, `401`, `403` (including a sender domain that isn't verified), `409 invalid_idempotent_request`, `422` | Failed |

Retries follow the delays of every delivery: 1 minute, 5 minutes, 30 minutes, 2 hours, then 6 hours, for 6 attempts in all. A stored list of recipients that no longer passes the rules also ends the delivery at once.

Resend compares the request with the first one that used the same key. If you change the recipients or `RONDYR_EMAIL_FROM` while a delivery is waiting for a retry, the next attempt gets `409 invalid_idempotent_request` and the delivery fails.

## Delivery guarantee

Delivery is at least once, as for webhooks. The idempotency key covers a retry within 24 hours, including a retry after the Worker stopped between the request and the record of its result. It doesn't cover a send more than 24 hours after the first attempt, and mail servers can also deliver one email twice. Two emails that end with the same delivery ID are the same delivery.

## Privacy

The content of a message leaves Rondyr in the email. Resend processes it and keeps the emails it sends for the data retention period of your plan, 30 days on the free plan. List Resend as a subprocessor if you send personal data, and sign Resend's [data processing addendum](https://resend.com/legal/dpa) if you need one. The delivery records in D1 contain IDs, states and error summaries, never the fields.

## Not built yet

- An adapter for Cloudflare's email service, chosen with `RONDYR_EMAIL_PROVIDER`, is planned in a separate issue.
- The dashboard doesn't show delivery history yet, and a failed delivery can't be retried by hand or tested with a sample email ([#16](https://github.com/basaltbytes/rondyr/issues/16)).
- The message text can't be changed, and it is only in French.
- Every member of an organization can manage its destinations; roles come with [#11](https://github.com/basaltbytes/rondyr/issues/11).
