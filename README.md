<h1 align="center">Rondyr</h1>

<p align="center">The gatekeeper for your forms: a form backend with spam filtering that runs in your own Cloudflare account.</p>

<p align="center">
  <img alt="Status: pre-alpha" src="https://img.shields.io/badge/status-pre--alpha-red">
  <a href="https://github.com/basaltbytes/rondyr/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/basaltbytes/rondyr/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="./LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-blue"></a>
</p>

> [!WARNING]
> Rondyr is pre-alpha software. It receives, classifies, and stores submissions, and sends accepted ones to signed webhooks and by email through Resend. The data model and the HTTP API can change in any commit.

Rondyr is a self-hosted alternative to hosted form services. You deploy one Cloudflare Worker, create a form, and point your site's `<form>` at its URL. Each submission is stored in D1 before anything else happens, then a classifier scores it for spam and, if you described your business, for relevance to it.

Rondyr never deletes a message on a model's opinion. A clear message is accepted, and anything doubtful waits in quarantine until you accept or archive it in the dashboard. A classifier outage also sends the message to quarantine instead of losing it.

## Quick start

You need Node.js 24.22 or later and pnpm 11. The local setup needs no Cloudflare account: Wrangler emulates D1, the queues, and the Durable Objects.

```sh
pnpm install --frozen-lockfile
cp .env.example .env
```

Generate two different values with `openssl rand -hex 32`, and set them as `BETTER_AUTH_SECRET` and `RONDYR_SETUP_TOKEN` in `.env`. To try webhooks, also set `RONDYR_SECRETS_KEY` to the output of `openssl rand -base64 32`. Email destinations need `RESEND_API_KEY` and `RONDYR_EMAIL_FROM`, and they send real email; see [docs/email.md](./docs/email.md). Then apply the migrations and start the Worker and the dashboard:

```sh
pnpm db:migrate
pnpm dev
```

Vite prints the local URL, usually `http://localhost:5173`. Public sign-up is closed, so create the first account with the setup script in a second terminal:

```sh
./scripts/setup-owner.sh http://localhost:5173
```

The script asks for the setup token, a name, an email address, and a password of 12 to 128 characters. Its prompts and the dashboard are in French for now. After it prints `HTTP 201`, sign in at `/`, then remove `RONDYR_SETUP_TOKEN` from `.env` and restart `pnpm dev`. The setup endpoint refuses to create a second account even if the token stays.

## Send a submission

In the dashboard, create an inbox: an organization name, a form name, and an optional description of the business. Open **Adresses des formulaires** to copy the form URL, then post to it:

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

A `202` means D1 has stored the submission and the event that queues it for classification, in one transaction. It doesn't mean the classifier has run. A browser that posts an HTML form gets a confirmation page with the same status.

The body can be `application/json` or `application/x-www-form-urlencoded`, up to 16 KiB, with 1 to 32 text fields of at most 4,000 characters each. A form accepts 30 submissions per minute. Rondyr answers `400` for invalid fields, `403` for a browser on an origin that the form doesn't allow, `404` for an unknown form, `413` for a large body, `415` for another content type, and `429` over the rate limit.

### Allowed origins

By default a form accepts submissions from a page on any origin. To restrict it, open **Origines autorisées** in the dashboard and add the origins of your site, such as `https://www.example.com`. An origin is a scheme, a host, and an optional port, with no path. It must use HTTPS, except `http://localhost` and loopback addresses such as `http://127.0.0.1:8080` during development.

Once a form has at least one allowed origin, Rondyr answers `403` to a browser that sends any other `Origin` header, whether it posts with `fetch` or with an HTML form, and stores nothing. A request without an `Origin` header, from curl or a server, is still accepted, and so is one with `Origin: null`, which a browser sends when the page hides its origin (a `no-referrer` policy, a sandboxed frame). This list keeps another site from sending messages to your form through its visitors' browsers; it doesn't stop spam from scripts, which can send any header.

Locally there is no Workers AI binding, so every message is quarantined with the reason **Analyse indisponible**. Click **Actualiser** a few seconds after posting to see it; you can then open, accept, or archive it.

## Features

- Stores each submission and its outbox event atomically before answering, then publishes the event to the classification queue in the background of the same request. A cron job runs every minute as the recovery path: it publishes the events whose first publication failed, and republishes any event that wasn't handed to the classifier within 5 minutes. A duplicate queue message produces one decision.
- Scores spam and business relevance with Jev or with OpenAI Decisions, both through Workers AI and the Cloudflare AI Gateway named `default`, with gateway logging off on each call. You choose one classifier per deployment.
- Quarantines instead of deleting. Probable spam, ambiguous scores, off-topic messages, and classifier failures all go to human review, each with its reason.
- Calls the classifier up to three times in a durable saga, which resumes after a restart in the middle of a classification.
- Shows an inbox per organization with status filters and cursor pagination. Two reviewers who decide on the same message at the same time get one accepted decision and one `409`.
- Answers CORS preflights on the form URL, so a page on another origin can post JSON with `fetch`. Each form can restrict the origins that browsers may submit from.
- Isolates organizations. Every admin query is scoped to the signed-in account's organizations, and another organization's submission answers `404`.
- Creates one delivery per active destination of the form when a message is accepted, automatically or in review, and queues it through the same D1 outbox and cron. Each delivery has a stable ID that the recipient gets on every attempt. A retryable failure is attempted again after 1 minute, 5 minutes, 30 minutes, 2 hours, and 6 hours, then the delivery is marked as failed; a crash between the send and its record leads to a second send with the same ID.
- Sends accepted messages to the form's webhooks as a versioned JSON `POST`, signed with HMAC-SHA-256 over the timestamp and the body. Signing secrets are generated by Rondyr, shown once, encrypted in D1 with `RONDYR_SECRETS_KEY`, and can be rotated with a 24-hour overlap. Rondyr refuses non-HTTPS URLs, private and reserved IP literals, local hostnames, its own origin, and redirects. [docs/webhooks.md](./docs/webhooks.md) has the payload, the headers, and a verification example.
- Sends accepted messages by email through [Resend](https://resend.com), as plain text with every field, to up to 10 recipients per destination. The delivery ID is Resend's idempotency key, so a retry within 24 hours doesn't send a second email. Visitor input never goes into a header: the subject is built from the form name, and a field named `email` becomes `Reply-To` only when it is a single valid address. A stage needs `RESEND_API_KEY` and a sender address on a verified domain; [docs/email.md](./docs/email.md) has the setup, the limits, and the message format.
- Keeps message content in D1, and sends it only in webhook bodies and emails. The event history of a submission contains IDs, scores, and the reviewer, never the fields.
- Deploys through [Alchemy](https://alchemy.run), with separate resources for the `staging` and `prod` stages.

## Not built yet

The [open issues](https://github.com/basaltbytes/rondyr/issues) are the roadmap. The largest gaps:

| Gap | Issue |
| --- | --- |
| Email through Cloudflare's email service, as an alternative to Resend | Follow-up of [#14](https://github.com/basaltbytes/rondyr/issues/14) |
| Delivery history, manual retry, and test sends in the dashboard | [#16](https://github.com/basaltbytes/rondyr/issues/16) |
| Editing, suspending, and adding forms | [#8](https://github.com/basaltbytes/rondyr/issues/8) |
| Per-IP rate limits, honeypot, Turnstile, and quotas | [#7](https://github.com/basaltbytes/rondyr/issues/7) |
| Thresholds measured on a test corpus, per-organization policy | [#6](https://github.com/basaltbytes/rondyr/issues/6) |
| Roles and invitations | [#11](https://github.com/basaltbytes/rondyr/issues/11) |
| Search, export, retention, and purge | [#9](https://github.com/basaltbytes/rondyr/issues/9) |

## Concepts

- An **organization** owns forms and an inbox. An account sees only the organizations it is a member of.
- A **form** has a public URL, `/f/<public-id>`, and an optional **business context** that describes what the organization does.
- A **submission** is one message: a set of text fields sent to a form.
- The **classifier** returns a spam score and, when the form has a business context, a relevance score. Both are between 0 and 1.
- A submission is **accepted** when its spam score is under 0.30 and its relevance score, if it has one, is at least 0.35. Otherwise it is **quarantined** with a reason: probable spam (0.70 and above), ambiguous, low relevance, or classifier error.
- A **review** is a person's decision on a quarantined submission: accept it, or archive it.
- A **destination** receives the accepted submissions of a form: a **webhook**, or an **email** destination with a list of recipients. Each accepted submission creates one **delivery** per active destination.

## Deploy to Cloudflare

```sh
pnpm exec alchemy profile edit --config alchemy-run.ts --add Cloudflare
pnpm deploy:plan --stage staging --env-file .env.staging
pnpm run deploy --stage staging --env-file .env.staging
```

The stack creates the Worker with the dashboard assets, a D1 database with its migrations applied, the classification and delivery queues with their dead-letter queues, the cron trigger, and the Durable Objects. [docs/deployment.md](./docs/deployment.md) covers the environment file, the custom domain, the first account on a remote stage, the classifier choice, the email settings, and deployment from GitHub Actions.

## Documentation

| Topic | Page |
| --- | --- |
| What is built, what is planned, and why | [architecture.md](./architecture.md) (French) |
| Stages, secrets, API token permissions, CI deployment | [docs/deployment.md](./docs/deployment.md) |
| Webhook payload, signature, verification, retries | [docs/webhooks.md](./docs/webhooks.md) |
| Email setup with Resend, limits, message format, retries | [docs/email.md](./docs/email.md) |
| Development setup, pull requests, license of contributions | [CONTRIBUTING.md](./CONTRIBUTING.md) |
| Rules for contributors and coding agents | [AGENTS.md](./AGENTS.md) (French) |
| Local lint rules and where they come from | [tooling/oxlint/README.md](./tooling/oxlint/README.md) |

## Development

```sh
pnpm check         # lint, format, types, tests in workerd, Knip, migrations
pnpm deploy:dry    # build, validate the bundle with Wrangler, check its size budget
```

CI runs both commands without Cloudflare credentials. The tests build the Worker first and run it in workerd with D1, the queues, and the Durable Objects emulated.

After a schema change in `src/adapters/database`, run `pnpm db:generate --name your-migration-name`, read the generated SQL, and commit the new folder in `database/migrations`. `pnpm dev:alchemy` runs the Alchemy stack locally with its own state and D1 database, as an alternative to `pnpm dev`.

## License

Rondyr is licensed under the [GNU Affero General Public License v3.0](./LICENSE). You can run it, change it, and deploy it for your own forms. If you offer Rondyr, or software that includes it, to others over a network, you have to publish the complete source of that software under the same license.

## Author

Rondyr is built by [Basaltbytes](https://basaltbytes.com).
