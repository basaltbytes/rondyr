# Email

When a message is accepted, automatically or in review, Rondyr sends it as one plain text email to the recipients of each active email destination of its form. Each stage uses Resend by default or can opt in to Cloudflare Email Sending.

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
| `RONDYR_EMAIL_PROVIDER` | Setting, optional | `resend`, the default |

The deployment refuses a `RONDYR_EMAIL_FROM` that isn't a bare address: `Rondyr <forms@example.com>` is refused. [deployment.md](./deployment.md#email) lists the matching GitHub secrets and variables.

### Resend limits and cost

Resend's prices and limits change; check [Pricing](https://resend.com/pricing) and [Account quotas and limits](https://resend.com/docs/knowledge-base/account-quotas-and-limits) before you rely on them. In November 2026 they were:

- The free plan sends 3,000 emails a month and 100 a day, from up to 3 domains. The daily quota resets at midnight UTC.
- Paid plans start at $20 a month for 50,000 emails, with no daily limit, and bill extra emails in blocks of 1,000.
- Each recipient counts as one email. A destination with 4 recipients uses 4 emails per accepted message.
- The API accepts 10 requests per second per team. See [Rate limit](https://resend.com/docs/api-reference/rate-limit).
- Resend expects a bounce rate under 4% and a spam complaint rate under 0.08%.

A message over quota or over the rate limit gets `429`, which Rondyr retries. A daily quota reached in the afternoon resets at midnight UTC, which can be after the last retry (about 8 and a half hours after the first attempt), so these messages can end up failed. They stay in the inbox either way.

## Setup with Cloudflare Email Sending

1. Use Workers Paid and a sender domain on Cloudflare DNS in the same account as the Worker. In the Cloudflare dashboard, open **Compute → Email Service → Email Sending**, choose **Onboard Domain**, and complete domain setup. Check the domain's sending status after the DNS records propagate. [Domain configuration](https://developers.cloudflare.com/email-service/configuration/domains/)
2. Set `RONDYR_EMAIL_PROVIDER=cloudflare` and `RONDYR_EMAIL_FROM` to a bare address on that domain, for example `forms@notifications.example.com`. Redeploy the selected stage with Alchemy. It adds the `CLOUDFLARE_EMAIL` binding without a recipient allowlist. The binding uses the Worker's account and needs no email API key. After onboarding, the binding can send to any recipient without adding them to Cloudflare's verified destination list. [Send bindings](https://developers.cloudflare.com/email-service/configuration/send-bindings/)
3. Create an email destination and use **Send a test**. Keep Cloudflare's **Drop suppressed recipients** setting off if Rondyr should record a suppressed address as a failed delivery. [Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/#error-codes)

### Cloudflare limits and cost

Workers Paid includes 3,000 outbound emails per account per billing month, then charges $0.35 per 1,000 emails. Emails accepted for sending count toward the quota, including hard bounces. Sends to destination addresses already verified in the Cloudflare account are free. [Pricing](https://developers.cloudflare.com/email-service/platform/pricing/)

Cloudflare sets a daily sending limit per account and adjusts it based on sending history and reputation. It allows up to 50 recipients and 25 MiB per message. Rondyr allows up to 10 recipients per destination. [Limits](https://developers.cloudflare.com/email-service/platform/limits/)

## Missing configuration

The stage can deploy with email settings omitted. With no sender address or with the selected provider's key or binding missing, creating a destination answers `503` with `{"error":"email-provider-missing"}`. Listing and editing existing destinations still work. Deliveries to them fail without a retry.

## Destinations

In the dashboard, an admin of the organization opens **Destinations**, picks the form, enters the recipients under **Emails**, one per line, chooses the language of the emails, and clicks **Add destination**. **Edit recipients** replaces the list and the language, **Deactivate** stops deliveries for messages accepted from then on, and **Send a test** sends a [test email](#test-email) and shows the answer. A reviewer can't change destinations.

A destination has a language, English or French, in which Rondyr writes its emails. A destination created before this setting has no language and keeps getting its emails in French. A destination also has 1 to 10 recipients. Each one is a bare ASCII address such as `team@example.com`. Rondyr refuses a display name (`Team <team@example.com>`), several addresses in one entry, spaces, line breaks, an internationalized address, and the same address twice, ignoring case.

The dashboard calls these routes, which need a session cookie and the `Origin` of the Worker:

| Route | Effect |
| --- | --- |
| `GET /api/organizations/:organizationId/forms/:publicId/targets` | Lists the form's webhooks and email destinations, each with its `type` |
| `POST /api/organizations/:organizationId/forms/:publicId/targets` | Creates an email destination from `{"type":"email","recipients":["team@example.com"],"language":"en"}` (`201`). `language` is `en` or `fr`, and `en` when absent |
| `PUT /api/organizations/:organizationId/targets/:targetId/recipients` | Replaces the recipients from `{"recipients":[…]}`, and the language when the body also has `"language"` |
| `POST /api/organizations/:organizationId/targets/:targetId/deactivate` or `/activate` | Returns the destination with its new state |
| `POST /api/organizations/:organizationId/targets/:targetId/test` | Sends a test email and returns its result |
| `POST /api/organizations/:organizationId/targets/:targetId/confirmations` | Sends the confirmation email of a pending recipient again (`{"address":…}`), with a new link: `202`. `409` with `{"error":"recipient-confirmed"}`, `429` with `{"error":"confirmation-limit"}` and `Retry-After`, `404` for an address that isn't a recipient of the destination |
| `POST /api/recipient-confirmations` | Confirms the address of a link (`{"token":…}`): `204`, or `404` with `{"error":"confirmation-invalid"}`. No session is needed |

Each email destination in these responses has `recipientStatuses`: each recipient with the status `pending` or `confirmed`.

A refused list answers `400` with `{"error":"recipients-refused","reason":…}`, where the reason is `no-recipients`, `too-many-recipients`, `invalid-address` or `duplicate-address`. A form or destination of an organization the account isn't a member of answers `404`, and a reviewer of the organization gets `403`.

## Confirmed recipients

Rondyr sends email only to addresses whose owners agreed to get it. When a destination lists an address that the organization hasn't confirmed, Rondyr emails that address a plain text message with a single-use link, valid for 7 days:

```text
From: forms@notifications.example.com
To: team@example.com
Subject: Confirm your email address for Rondyr

Someone added this address as a recipient of the messages of a website form handled by Rondyr. You will get them only after you confirm.

To confirm, open this link and press the button. It works once, until 27 November 2026 at 15:42 UTC:
https://rondyr.example.com/confirm-recipient#…

If you do not want these messages, ignore this email: nothing will be sent to you.
```

The text is fixed, in the language of the destination, and names neither the organization nor the form, so nobody can use it to carry their own words. The page that the link opens, in English or in French following the browser, doesn't name them either, and confirms only when the person presses its button: a mail scanner that opens the link confirms nothing. The secret of the link sits in the URL fragment, which no request carries; D1 keeps its SHA-256 hash only.

An address is confirmed once per organization: it then gets the messages of every destination of every form of that organization. The dashboard shows **Waiting for confirmation** or **Confirmed** next to each recipient, and **Send again** emails a new link to a pending one; the new link replaces the previous one.

- A delivery goes to the confirmed recipients only. When none is confirmed, it fails without a retry with the summary `No recipient of this destination has confirmed their address yet.`, and the message stays accepted in the inbox.
- A [test email](#test-email) goes to the confirmed recipients only, and fails the same way when there is none.
- An address gets at most 3 confirmation emails per UTC day, counted across every organization of the stage. Beyond that, adding it to a destination sends nothing, and **Send again** answers `429` until midnight UTC.
- Without an email provider, no confirmation is sent and no email is counted; the recipients stay pending.

The migration that introduced confirmations marked every recipient of the email destinations that existed then as confirmed for its organization, so these destinations kept their deliveries.

## Message

The email is plain text, with no HTML, in the language of its destination. In English, for a form named `Classes`:

```text
From: forms@notifications.example.com
To: team@example.com
Reply-To: customer@example.com
Subject: New message: Classes

New message received through the form “Classes”.

email:
customer@example.com

message:
Is there room in the pottery class?

-- 
Form: Classes
Received: 20 November 2026 at 14:03:00 UTC
Delivery ID: 0f6c1a62-6b8e-4c43-9f5e-2d3a9b7c4e11

Rondyr may send the same delivery twice. Two messages with the same delivery ID are duplicates.
```

The body lists every field, then the form name, the time of reception in UTC, and the delivery ID. Field names that are JavaScript array indices, such as `"1"` and `"2"`, appear first in numeric order. The other fields follow in the order received.

Field names and values come from visitors, so none of them goes into a header, with one exception. When the submission has a field named exactly `email` whose value is a single valid address, with no display name, no space and no line break, it becomes the `Reply-To` address, and answering the email writes to the visitor. Any other value, such as `visitor@example.com` followed by a line break, leaves the email without `Reply-To`. The subject is built from the form name only. In the body, line breaks inside a field name become spaces, and line breaks inside a value become plain `\n`.

## Test email

**Send a test** in the dashboard, or the `test` route, sends one email to the recipients of the destination, through the same provider and with the same checks as a delivery. For a form named `Classes`:

```text
From: forms@notifications.example.com
To: team@example.com
Subject: Test message: Classes

Test message sent from the Rondyr dashboard for the form “Classes”.

No visitor sent this message. It checks that the emails of this form reach these recipients.

-- 
Form: Classes
Sent: 20 November 2026 at 15:42:07 UTC
Test ID: 4f0c8a52-91d3-4b6e-a8f7-2c5d1e9b3a60
```

**Send a test** goes to the confirmed recipients of the destination only, and only an admin of the organization can send one. Each test has a new ID, which Resend uses as its idempotency key. Each test sends an email that is subject to the provider's quota. Rondyr waits up to 30 seconds, makes one attempt, and stores no submission, delivery, or attempt record. The route returns `testId` and an `outcome` of `delivered`, `retryable-failure` or `permanent-failure`. Failed tests include a `summary` with the available status or error code. A destination gets at most 3 tests per minute, counted by the Rate Limiting binding `TARGET_TEST_RATE_LIMIT`: a fourth one answers `429` with `Retry-After: 60`, and if the binding doesn't answer, the test is refused with `503`. While a test of a destination runs, a second test of the same destination answers `409` on that Worker instance.

## Responses and retries

Retries follow the same schedule for both providers. Rondyr waits 1 minute, 5 minutes, 30 minutes, 2 hours, then 6 hours, for 6 attempts in all. A stored list of recipients that no longer passes the rules ends the delivery at once.

### Resend responses

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

Resend compares the request with the first one that used the same key. If you change the recipients or `RONDYR_EMAIL_FROM` while a delivery is waiting for a retry, the next attempt gets `409 invalid_idempotent_request` and the delivery fails.

### Cloudflare responses

The binding returns a message ID on success and throws an error with a code on a service failure. Rondyr records only known error codes, without Cloudflare's error text. The binding does not return an HTTP status. [Workers API error codes](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/#error-codes)

| Result | Rondyr behavior |
| --- | --- |
| `E_EMAIL_SENDING_NOT_READY`, `E_RATE_LIMIT_EXCEEDED`, `E_DAILY_LIMIT_EXCEEDED`, `E_INTERNAL_SERVER_ERROR` | Retried |
| Unknown error, or no answer within 30 seconds | Retried |
| Other documented errors, including suppressed recipients, sender configuration and SMTP rejection, or an invalid binding argument | Failed |

A manual retry from the dashboard keeps the delivery ID and starts a new series of 6 attempts. Resend still checks its original request during the 24-hour idempotency window. [Delivery history and manual retry](./webhooks.md#delivery-history-and-manual-retry)

## Delivery guarantee

Delivery is at least once, as for webhooks. Resend deduplicates retries within 24 hours, including after the Worker stops between sending and recording the result. The Cloudflare binding has no documented idempotency key. If it accepts an email and Rondyr times out or stops before recording the result, a retry can send the email again. Mail servers can also deliver duplicates. Two emails that end with the same delivery ID are the same delivery.

## Privacy

The selected provider processes the contents of sent emails. Resend keeps sent emails for the retention period of your plan, 30 days on the free plan. The delivery records in D1 contain IDs, states and error summaries. If you send personal data, list the stage's provider, Resend or Cloudflare, as a subprocessor and sign its data processing addendum if you need one. [Resend data processing addendum](https://resend.com/legal/dpa) · [Cloudflare data processing addendum](https://www.cloudflare.com/cloudflare-customer-dpa/)

## Not built yet

- The message text can't be changed. It exists in English and in French.
- A recipient can't withdraw its confirmation from the page; an admin removes the address from the destinations instead.
