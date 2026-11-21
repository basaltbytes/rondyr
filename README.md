<h1 align="center">Rondyr</h1>

<p align="center">The gatekeeper for your forms: a form backend with spam filtering that runs in your own Cloudflare account.</p>

<p align="center">
  <img alt="Status: pre-alpha" src="https://img.shields.io/badge/status-pre--alpha-red">
  <a href="https://github.com/basaltbytes/rondyr/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/basaltbytes/rondyr/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="./LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-blue"></a>
</p>

> [!WARNING]
> Rondyr is pre-alpha software. It receives, classifies, and stores submissions, and sends accepted ones to signed webhooks and by email through Resend or Cloudflare Email Sending. The data model and the HTTP API can change in any commit.

Rondyr is a self-hosted alternative to hosted form services. You deploy one Cloudflare Worker, create a form, and point your site's `<form>` at its URL. Each submission is stored in D1 before anything else happens, then a classifier scores it for spam and, if you described your business, for relevance to it.

Rondyr never deletes a message on a model's opinion. A clear message is accepted, and anything doubtful waits in quarantine until you accept or archive it in the dashboard. A classifier outage also sends the message to quarantine instead of losing it.

## Quick start

You need Node.js 24.22 or later and pnpm 11. The local setup needs no Cloudflare account: Wrangler emulates D1, the queues, and the Durable Objects.

```sh
pnpm install --frozen-lockfile
cp .env.example .env
```

Generate two different values with `openssl rand -hex 32`, and set them as `BETTER_AUTH_SECRET` and `RONDYR_SETUP_TOKEN` in `.env`. To try webhooks or Turnstile, also set `RONDYR_SECRETS_KEY` to the output of `openssl rand -base64 32`. The default email provider, Resend, needs `RESEND_API_KEY` and `RONDYR_EMAIL_FROM` and sends real email. [Email setup](./docs/email.md)

Apply the migrations and start the Worker and the dashboard.

```sh
pnpm db:migrate
pnpm dev
```

Vite prints the local URL, usually `http://localhost:5173`. Public sign-up is closed, so create the first account with the setup script in a second terminal:

```sh
./scripts/setup-owner.sh http://localhost:5173
```

The script asks for the setup token, a name, an email address, and a password of 12 to 128 characters. After it prints `HTTP 201`, sign in at `/`, then remove `RONDYR_SETUP_TOKEN` from `.env` and restart `pnpm dev`. The setup endpoint refuses to create a second account even if the token stays.

## Send a submission

In the dashboard, create an inbox: an organization name, a form name, and an optional description of the business. Open **Forms** to copy the form URL, then post to it:

```sh
curl --json '{"email":"visitor@example.com","message":"Is there room in the pottery class?"}' \
  http://localhost:5173/f/YOUR_PUBLIC_ID
```

```json
{ "submission-id": "73123ee4-40bf-4c5f-b8ff-1d56cdaa7640", "status": "received" }
```

An HTML form works with the same URL:

```html
<form action="https://rondyr.example.com/f/YOUR_PUBLIC_ID" method="post">
  <input type="email" name="email" required />
  <textarea name="message" required></textarea>
  <button type="submit">Send</button>
</form>
```

A page on another origin can call the same URL with `fetch`:

```js
const response = await fetch("https://rondyr.example.com/f/YOUR_PUBLIC_ID", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "visitor@example.com", message: "Is there room in the pottery class?" }),
});
if (!response.ok) throw new Error(`Rondyr answered ${response.status}`);
const { "submission-id": submissionId } = await response.json();
```

Don't send cookies: `credentials: "include"` makes the browser refuse the response.

A `202` means D1 has stored the submission and the event that queues it for classification, in one transaction. It doesn't mean the classifier has run.

The body can be `application/json`, `application/x-www-form-urlencoded`, or `multipart/form-data`, up to 16 KiB, with 1 to 32 message fields of at most 4,000 characters each. A field name has 1 to 100 characters, with no control character or line break. The optional `cf-turnstile-response` field is separate from the message. See [Rate limits](#rate-limits) for the per-client, per-form, and daily organization limits.

| Status | Meaning |
| --- | --- |
| `202` | Stored. The JSON body has `submission-id` and `status: "received"` |
| `303` | Stored, and the browser is sent to the form's success URL (see below) |
| `400` | Invalid body or fields, a file in a multipart body, or no message fields after removing the Turnstile token and an empty honeypot |
| `403` | The form is suspended, or a browser on an origin that the form doesn't allow sent it. Nothing is stored |
| `404` | Unknown form |
| `413` | Body larger than 16 KiB |
| `415` | Another content type |
| `429` | The client or form reached its minute limit, or the organization reached a daily quota: the submission quota, or the junk quota for a submission that intake would quarantine as junk. `Retry-After` gives the wait in seconds. Nothing is stored |
| `503` | D1 unavailable |

### HTML forms

A browser that posts an HTML form sends `Accept: text/html`. Rondyr answers it with a confirmation page, in French or in English depending on the browser's `Accept-Language`, and the status `202`, or, when the form has a success URL, with `303 See Other` to that URL. You set the success URL for each form in **Forms**. It must use HTTPS, and its origin must be one of the form's [allowed origins](#allowed-origins), so add the origin first. Rondyr only redirects to the stored URL: a field, a query parameter, or a header of the request can't choose another one. A `fetch` with a JSON body, or a client that doesn't accept HTML, gets the `202` JSON answer.

A group of checkboxes or a multiple `<select>` sends the same field name several times. Rondyr joins the values with `, ` in the order received, so `topic=glaze&topic=kiln` is stored as `topic: "glaze, kiln"`. The joined value must still fit in 4,000 characters. JSON bodies take string values only.

`multipart/form-data` (`enctype="multipart/form-data"`) works for text fields only. A part with a filename, including a file input left empty, makes Rondyr answer `400` and store nothing.

### Honeypot field

A honeypot is a field that people don't see and leave empty, while many bots fill in every field they find. Name it for each form in **Forms**, for example `_hp`, then add it to your form, hidden with CSS rather than with `type="hidden"`, out of the tab order and of autofill:

```html
<form action="https://rondyr.example.com/f/YOUR_PUBLIC_ID" method="post">
  <input type="email" name="email" required />
  <textarea name="message" required></textarea>
  <div aria-hidden="true" style="position: absolute; left: -10000px">
    <label>Leave this field empty <input type="text" name="_hp" tabindex="-1" autocomplete="off" /></label>
  </div>
  <button type="submit">Send</button>
</form>
```

When the field arrives empty, Rondyr removes it before storing the message, so it never reaches the classifier, a webhook, or an email. When it has a value, Rondyr gives the usual answer (the same `202`, confirmation page, or redirect), stores the message with the field, and quarantines it with the reason **Honeypot field filled** without calling the classifier. You can still accept it in the dashboard, for example when a browser's autofill filled the field, and its deliveries then go out as for any accepted message. A body with the empty honeypot field as its only field gets `400`. Without a honeypot field, a field named `_hp` is an ordinary field.

### Suspended forms

A suspended form answers `403` to every submission and stores nothing, with the same CORS headers as an active form. Its messages, its destinations, its allowed origins, and its URL don't change, and reactivating it accepts submissions again. Suspend and reactivate a form in **Forms**.

### Turnstile

Create a Cloudflare Turnstile widget for the hostname that serves your form. In **Forms**, pick the form, save the widget's site key and secret key, then copy the HTML into your form. For a JSON integration, send the widget's token in the `cf-turnstile-response` field. The Worker needs `RONDYR_SECRETS_KEY` to encrypt the widget secret in D1. [Cloudflare's widget setup guide](https://developers.cloudflare.com/turnstile/get-started/)

When you save the keys, Rondyr asks Siteverify whether it knows the secret key. If Siteverify refuses it, for example because a character is missing, nothing is saved and the dashboard asks you to copy the key again. If Siteverify doesn't answer, nothing is saved either; try again a moment later. Cloudflare's [test secret keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/) pass this check.

Rondyr removes the token before storing the message. A missing or refused token sends the message to **To review** with the reason **Turnstile verification failed**, and the visitor still gets the usual response. Rondyr reads Siteverify's answer from the JSON body of an HTTP 200 or 400 reply, so a refusal counts whatever its status. If Siteverify doesn't answer within five seconds, answers with another status, reports `internal-error`, or no longer recognizes the secret key, Rondyr logs the incident and lets the other intake checks and classification proceed.

A key can stop working after you saved it: someone deletes the widget in Cloudflare, or `RONDYR_SECRETS_KEY` changes and the stored key no longer decrypts. Messages then go to classification without the Turnstile check. Each time you open the form in **Forms**, Rondyr decrypts the stored key and asks Siteverify about it again. If the key no longer works, the Turnstile card warns that Turnstile isn't protecting the form; save both keys again to turn it back on. If Cloudflare doesn't answer, the card says so, and reloading the page checks again. The same check is available at `GET /api/organizations/:organizationId/forms/:publicId/turnstile`, which returns `{"state":"working"}`, `refused`, `unreadable` or `unchecked`.

### Allowed origins

By default a form accepts submissions from a page on any origin. To restrict it, open **Allowed origins** in the dashboard and add the origins of your site, such as `https://www.example.com`. An origin is a scheme, a host, and an optional port, with no path. It must use HTTPS, except `http://localhost` and loopback addresses such as `http://127.0.0.1:8080` during development.

Once a form has at least one allowed origin, Rondyr answers `403` to a browser that sends any other `Origin` header, whether it posts with `fetch` or with an HTML form, and stores nothing. The origin of the form's success URL can't be removed from the list while the success URL is set; clear the success URL first. A request without an `Origin` header, from curl or a server, is still accepted, and so is one with `Origin: null`, which a browser sends when the page hides its origin (a `no-referrer` policy, a sandboxed frame). This list keeps another site from sending messages to your form through its visitors' browsers; it doesn't stop spam from scripts, which can send any header.

Locally there is no Workers AI binding, so every message is quarantined with the reason **Analysis unavailable**. Click **Refresh** a few seconds after posting to see it; you can then open, accept, or archive it.

### Rate limits

Rondyr limits each client to 5 submissions per minute on each form, before it stores anything, so a single client can't use up the form's own cap of 30 per minute and get other visitors' messages refused. A client is the IP address that Cloudflare sends in `CF-Connecting-IP`, or the `/64` network of an IPv6 address. The counters are in Cloudflare's [Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) binding, not in D1, so Rondyr stores no IP address. Cloudflare counts per data center and approximately: a client can get a few more submissions through, and the form's cap still applies to everyone. When the counter doesn't answer, the submission is accepted. A request without `CF-Connecting-IP`, as in local development, isn't counted.

Both minute limits answer `429` with `Retry-After: 60` and store nothing. A page on an allowed origin can read the response and the `Retry-After` header.

**Daily quotas** shows usage across the organization's forms for the current UTC day. The defaults are 2,000 stored submissions and 1,000 classifications. An organization member can change the limits there or with `PUT /api/organizations/:organizationId/quotas`, using integer fields `submissions` (1 to 100,000) and `classifications` (0 to 100,000). A `GET` on the same URL returns the UTC day, limits and usage.

Junk has its own storage quota, equal to the submission limit. Junk is a message that intake quarantines because it filled the honeypot field, failed Turnstile, or repeats earlier messages; **Daily quotas** counts it under **Junk caught at intake**, and the API under `used.junk`. A bot that sends junk all day uses up the junk quota, not the one of your visitors. An organization therefore stores at most twice its submission limit per day: 4,000 messages with the default.

After a storage quota is reached, Rondyr returns `429` with the number of seconds until midnight UTC in `Retry-After`, and stores nothing: junk is refused once the junk quota is reached, any other submission once the submission quota is reached. Junk normally gets the same `202` as other messages, so the `429` tells a bot that it was caught; that is the price of not letting it fill the submission quota. After the classification quota is reached, Rondyr stores messages and sends them to review with the reason **Daily classification quota reached**. Those messages can be real, so they use the submission quota, not the junk one. A submission uses one classification slot when intake admits it to the classifier. Workflow retries use the same slot. When an ambiguous submission goes to a second model, the escalation uses one more slot, taken before the call; if none is left, the second model isn't called and the submission stays in review as ambiguous.

## Features

- Stores each submission and its outbox event atomically before answering, then publishes the event to the classification queue in the background of the same request. A cron job runs every minute as the recovery path: it publishes the events whose first publication failed, and republishes any event that wasn't handed to the classifier within 5 minutes. After 12 publications without a hand-off, about an hour, the event is marked stuck: the message stays stored, **Status** lists it, and a member retries it by hand. A duplicate queue message produces one decision.
- Scores spam, unsolicited sales outreach, and business relevance with Jev or OpenAI Decisions. Both use Workers AI and the Cloudflare AI Gateway named `default`, with gateway logging off on each call. You choose one classifier per deployment.
- Quarantines instead of deleting. Probable spam, ambiguous scores, sales pitches, off-topic messages, and classifier failures all go to human review, each with its reason. Once the model answers again, **Reclassify** sends a message that the classifier failed on back to it.
- Limits each client per form with Cloudflare's Rate Limiting binding before anything is stored, without keeping IP addresses. A form can have a honeypot field: a filled one sends the message to quarantine without a classifier call, and the visitor gets the usual answer.
- Calls the classifier up to three times in a durable saga, which resumes after a restart in the middle of a classification.
- Shows an inbox per organization with status filters and cursor pagination. Two reviewers who decide on the same message at the same time get one accepted decision and one `409`.
- Answers CORS preflights on the form URL, so a page on another origin can post JSON with `fetch`. Each form can restrict the origins that browsers may submit from.
- Manages the forms of an organization in the dashboard: add a form, rename it, edit its business context, suspend and reactivate it, and redirect HTML form posts to a page of your site. A form keeps its public URL through every change.
- Lets an organization declare up to ten domains in the dashboard. When the submitted email address uses one of these domains or a subdomain, both classifiers are told so and get the email field blank; for any other sender, the classifier input is unchanged.
- Isolates organizations. A session is scoped to its account's organizations, and an API token is scoped to its own organization. Another organization's submission returns `404`.
- Lets members create and revoke organization API tokens in **Settings → API tokens**. A token can read the inbox, accept messages, and archive them. See [API tokens and review routes](./docs/api.md).
- Accepts submissions from a site's server with an API token. A server intake skips the browser checks (allowed origins, the per-client limit, Turnstile) and keeps the form cap, the daily quotas, and the honeypot field. An `Idempotency-Key` header makes a retry return the first submission instead of storing a second one. See [Server intake](./docs/api.md#server-intake).
- Connects EmDash sites through `@basaltbytes/emdash-plugin-rondyr`, in `packages/emdash-plugin/` (MIT). The site's forms plugin keeps validating and storing each submission; the plugin queues it, sends it to Rondyr with an idempotency key, shows the three folders in the EmDash admin, and emails accepted messages through the site's mailer. See [EmDash plugin](./docs/emdash.md).
- Creates one delivery per active destination of the form when a message is accepted, automatically or in review, and queues it through the same D1 outbox and cron. Each delivery has a stable ID that the recipient gets on every attempt. A retryable failure is attempted again after 1 minute, 5 minutes, 30 minutes, 2 hours, and 6 hours, then the delivery is marked as failed; a crash between the send and its record leads to a second send with the same ID.
- Sends accepted messages to the form's webhooks as a versioned JSON `POST`, signed with HMAC-SHA-256 over the timestamp and the body. Signing secrets are generated by Rondyr, shown once, encrypted in D1 with `RONDYR_SECRETS_KEY`, and can be rotated with a 24-hour overlap. Rondyr refuses non-HTTPS URLs, private and reserved IP literals, local hostnames, its own origin, and redirects. [docs/webhooks.md](./docs/webhooks.md) has the payload, the headers, and a verification example.
- Sends accepted messages by email through Resend or Cloudflare Email Sending, as plain text with every field, to up to 10 recipients per destination. Resend deduplicates retries for 24 hours. The subject comes from the form name, and a valid address in the `email` field becomes `Reply-To`. [Email setup, limits and message format](./docs/email.md)
- Shows the deliveries of each accepted message in the dashboard: the destination, the status, and every attempt with its start and end times and its error summary. A failed delivery can be retried by hand; the retry keeps the delivery ID, starts a new series of up to 6 attempts, and two retries at the same time start one attempt. Each webhook and email destination can also receive a test message, marked as a test, without creating a submission or a delivery.
- Keeps message content in D1, and sends it only in webhook bodies and emails. The event history of a submission contains IDs, scores, and the account or API token that decided, never the fields.
- Deploys to your own Cloudflare account through [Alchemy](https://alchemy.run), by hand or from GitHub Actions on each push to `main`, then checks that the deployment answers.

## Not built yet

The [open issues](https://github.com/basaltbytes/rondyr/issues) are the roadmap. The largest gaps:

| Gap | Issue |
| --- | --- |
| Roles and invitations | [#11](https://github.com/basaltbytes/rondyr/issues/11) |
| Search, export, retention, and purge | [#11](https://github.com/basaltbytes/rondyr/issues/11) |

## Concepts

- An **organization** owns forms and an inbox. An account sees only the organizations it is a member of.
- A **form** has a public URL, `/f/<public-id>`, and an optional **business context** that describes what the organization does. A form is **active** or **suspended**; a suspended form refuses new submissions and keeps the ones it has.
- A **submission** is one message: a set of text fields sent to a form.
- The **classifier** returns a spam score, a sales outreach score and, when the form has a business context, a relevance score. Each one is between 0 and 1. The outreach score measures whether the sender is trying to sell or pitch something of their own to the organization. A customer asking for a quote, a shop that wants to stock the organization's products, a journalist, or a peer proposing a partnership doesn't count as outreach.
- A submission is **accepted** when its spam score is under 0.30, its outreach score is 0.50 or less, and its relevance score, if it has one, is at least 0.50 with Jev or 0.45 with OpenAI Decisions. Otherwise it is **quarantined** with the first reason that applies, in this order: probable spam (0.70 and above), ambiguous, unsolicited sales outreach, low relevance. A failed or incomplete classifier answer gives the reason classifier error. A submission with a filled honeypot field is quarantined with the reason honeypot, and the classifier doesn't score it.
- A **review** is a person's decision on a quarantined submission: accept it, or archive it.
- A **destination** receives the accepted submissions of a form: a **webhook**, or an **email** destination with a list of recipients. Each accepted submission creates one **delivery** per active destination.

## Deploy to Cloudflare

```sh
pnpm exec alchemy profile edit --config alchemy-run.ts --add Cloudflare
pnpm deploy:plan --stage prod --env-file .env.prod
pnpm run deploy --stage prod --env-file .env.prod
pnpm smoke https://forms.example.com --health-timeout 900
```

The stack creates the Worker with the dashboard assets, a D1 database with its migrations applied, the classification and delivery queues with their dead-letter queues and consumers, the cron trigger, the Durable Objects, and the client rate limit. Plan on Workers Paid: [Costs and plan limits](./docs/deployment.md#costs-and-plan-limits) lists what each Cloudflare product costs, and the [fresh account checklist](./docs/deployment.md#fresh-account-checklist) walks through a first installation. [docs/deployment.md](./docs/deployment.md) covers the environment file, the custom domain, the first account, the classifier choice, the email settings, deployment from GitHub Actions, and a trial copy on a second stage.

## Documentation

| Topic | Page |
| --- | --- |
| What is built, what is planned, and why | [architecture.md](./architecture.md) |
| Installation on your Cloudflare account, secrets, API token permissions, CI deployment, costs | [docs/deployment.md](./docs/deployment.md) |
| Health check and smoke test, queue diagnosis, stuck processing, D1 recovery, Worker rollback, secret rotation | [docs/operations.md](./docs/operations.md) |
| Rondyr API tokens: authentication, review routes, server intake with an idempotency key, errors | [docs/api.md](./docs/api.md) |
| Webhook payload, signature, verification, retries | [docs/webhooks.md](./docs/webhooks.md) |
| EmDash plugin: installation, what editors see, outages, emails | [docs/emdash.md](./docs/emdash.md) |
| Email setup with Resend and Cloudflare, limits, message format, retries | [docs/email.md](./docs/email.md) |
| Evaluating the classifiers on a labeled corpus | [docs/evaluation.md](./docs/evaluation.md) |
| Development setup, pull requests, license of contributions | [CONTRIBUTING.md](./CONTRIBUTING.md) |
| Rules for contributors and coding agents | [AGENTS.md](./AGENTS.md) |
| Local lint rules and where they come from | [tooling/oxlint/README.md](./tooling/oxlint/README.md) |

## Development

```sh
pnpm check         # lint, format, types, tests in workerd and Node, Knip, migrations, for the Worker and the EmDash plugin
pnpm deploy:dry    # build, validate the bundle with Wrangler, check its size budget
```

CI runs both commands without Cloudflare credentials. The tests build the Worker first and run it in workerd with D1, the queues, and the Durable Objects emulated. The tests of the classifier evaluation harness in `evals/` run in Node; `pnpm evaluate --dry evals/corpus/synthetic.jsonl` runs it without credentials, and [docs/evaluation.md](./docs/evaluation.md) covers real runs.

After a schema change in `src/adapters/database`, run `pnpm db:generate --name your-migration-name`, read the generated SQL, and commit the new folder in `database/migrations`. `pnpm dev:alchemy` runs the Alchemy stack locally with its own state and D1 database, as an alternative to `pnpm dev`.

## License

Rondyr is licensed under the [GNU Affero General Public License v3.0](./LICENSE). You can run it, change it, and deploy it for your own forms. If you offer Rondyr, or software that includes it, to others over a network, you have to publish the complete source of that software under the same license.

## Author

Rondyr is built by [Basaltbytes](https://basaltbytes.com).
