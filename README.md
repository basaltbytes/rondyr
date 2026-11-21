<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./docs/brand/rondyr-dark-mode.svg">
    <img src="./docs/brand/rondyr-light-mode.svg" alt="Rondyr" width="260">
  </picture>
</h1>

<p align="center">A form backend for your website's contact forms that filters spam and runs in your own Cloudflare account.</p>

<p align="center">
  <img alt="Status: pre-alpha" src="https://img.shields.io/badge/status-pre--alpha-red">
  <a href="https://github.com/basaltbytes/rondyr/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/basaltbytes/rondyr/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="./LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-blue"></a>
</p>

<p align="center">
  <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/basaltbytes/rondyr"><img alt="Deploy to Cloudflare" src="https://deploy.workers.cloudflare.com/button"></a>
</p>

<p align="center">
  <img src="./docs/screenshots/inbox.webp" alt="The Rondyr dashboard: the Accepted folder lists five messages to a pottery studio, and the open one, a café asking for a quote on 40 stoneware cups, shows its webhook delivery as Delivered" width="900">
</p>

> [!WARNING]
> Rondyr is pre-alpha software. The data model and the HTTP API can change in any commit.

Point your site's `<form>` at Rondyr and it stores each message in your D1 database, asks a classifier whether it is spam, a sales pitch, or unrelated to your business, and sends the clear ones to your webhooks and mailboxes. Rondyr never deletes a message on a model's opinion: anything doubtful waits in **To review** with its reason until a person accepts or archives it, and a classifier outage sends messages there too instead of losing them. Everything runs as one Worker in your Cloudflare account, and the messages are stored in your own D1 database, not on a service run by someone else.

## Deploy your instance

You need a Cloudflare account on the Workers Paid plan ([Running costs](#running-costs) says why) and a GitHub or GitLab account. A domain is optional.

1. Click **Deploy to Cloudflare** above, sign in to Cloudflare, and connect your GitHub or GitLab account when Cloudflare asks.
2. Keep the default names on the form: the Worker `rondyr`, its D1 database, its queues, and its repository. Cloudflare creates that repository in your account as a copy of this one.
3. Fill in `RONDYR_SETUP_TOKEN`, a passphrase of at least 32 characters, and keep it for step 5. `openssl rand -base64 32` prints one.
4. Deploy. Workers Builds builds Rondyr, applies the D1 migrations, generates the other secrets, and deploys the Worker with its queues, Durable Objects, Cron trigger and Workers AI binding.
5. Open the Worker's address, `https://rondyr.<your-subdomain>.workers.dev`, shown in **Workers & Pages → rondyr**. The page **Create the owner account** asks for the setup token, then a name, an email address and a password of 12 to 128 characters.
6. Create an organization and its first form. Describe your business on the form if you want the classifier to set aside messages unrelated to it.

To use your own domain, add it later in **Workers & Pages → rondyr → Settings → Domains & Routes**. Each push to the `main` branch of your repository deploys it again. To bring a copy on GitHub up to date with this repository, run the **Update Rondyr** workflow in its **Actions** tab, then open a pull request from the branch it prepares and merge it. If you prefer a fork that follows this repository, fork it and import the fork in **Workers & Pages → Create → Import a repository**, then update it with GitHub's **Sync fork**. [docs/deployment.md](./docs/deployment.md) covers both paths, the optional settings (email, the classifier, a single address), and a checklist for a first installation.

## Receive your first submission

In the dashboard, open **Forms** and copy the form URL. Put it in the `action` of a form on your site:

```html
<form action="https://YOUR_RONDYR_HOST/f/YOUR_PUBLIC_ID" method="post">
  <label>Name <input name="name" required /></label>
  <label>Email <input type="email" name="email" required /></label>
  <label>Message <textarea name="message" required></textarea></label>
  <button type="submit">Send</button>
</form>
```

The visitor gets a confirmation page in English or French, or goes to a page of your site if you set a success URL for the form. To try it from a terminal:

```sh
curl --json '{"email":"visitor@example.com","message":"Is there room in the Saturday class?"}' \
  https://YOUR_RONDYR_HOST/f/YOUR_PUBLIC_ID
```

```json
{ "submission-id": "73123ee4-40bf-4c5f-b8ff-1d56cdaa7640", "status": "received" }
```

The message shows up in **Accepted** or **To review** once the classifier has scored it. To have accepted messages sent on, add a webhook or an email destination to the form in **Destinations**. [docs/forms.md](./docs/forms.md) covers `fetch` from another origin, the responses, the honeypot field, Turnstile, allowed origins, and the rate limits.

<p align="center">
  <img src="./docs/screenshots/review.webp" alt="The To review folder: six quarantined messages labeled Probable spam, Unsolicited sales outreach, Honeypot field filled, Uncertain classification and Unrelated to your business, with a sales pitch open and the Archive and Accept and send buttons" width="900">
</p>

## Features

- Stores each submission in D1 before it answers, and publishes it to the classifier through an outbox that a cron job retries every minute, so a queue or model outage delays a message instead of losing it.
- Scores spam, unsolicited sales outreach, and relevance to your business with Jev or OpenAI Decisions on Workers AI. Clear messages are accepted; the others wait in **To review** with their reason.
- Stops bots before the classifier with a per-client rate limit, a honeypot field, Cloudflare Turnstile, allowed origins, and daily quotas per organization, without storing IP addresses.
- Sends accepted messages to webhooks signed with HMAC-SHA-256, and by email through Resend or Cloudflare Email Sending to confirmed recipients, with retries and a delivery history.
- Lets the admins of an organization invite members as `admin` or `reviewer`, create API tokens, export messages to CSV or JSON Lines, delete them, and set retention periods. Every member can search the inbox.
- Takes JSON, URL-encoded, and multipart posts from an HTML form, a page script, or a server that sends an idempotency key.

The [open issues](https://github.com/basaltbytes/rondyr/issues) are the roadmap.

## How it works

1. Your site posts to `/f/<public-id>`. The Worker checks the limits, writes the message and an outbox event to D1 in one transaction, and answers `202`.
2. The classification queue hands the message to a Durable Object, which asks the classifier for its scores, up to three times.
3. The decision rules accept the message or quarantine it with a reason. Quarantined messages wait for a person in the dashboard.
4. Each accepted message creates one delivery per webhook or email destination, sent through a second queue with retries over about nine hours.
5. A cron job every minute republishes what a queue missed and lists anything stuck on the **Status** page.

[docs/concepts.md](./docs/concepts.md) has the terms and the thresholds, and [architecture.md](./architecture.md) the full design.

## Running costs

Rondyr bills nothing itself; Cloudflare bills your account for what the Worker uses. Rondyr needs the [Workers Paid](https://developers.cloudflare.com/workers/platform/pricing/) plan, at least $5 a month per account. On Workers Free, an invocation gets 10 ms of CPU time, which signing in can exceed because of the password hash, and the 10,000 queue operations a day run out after a few thousand messages. Beyond the amounts the plan includes, Cloudflare bills Workers requests, D1 rows, queue operations, Durable Object requests, and Workers AI usage for the classifier, and the daily quotas of each organization cap the classifier's share. [Costs and plan limits](./docs/deployment.md#costs-and-plan-limits) lists each product with its November 2026 price.

## Documentation

| Task | Page |
| --- | --- |
| Deploy, add a domain, update, configure email and the classifier, invite members | [docs/deployment.md](./docs/deployment.md) |
| Connect a form: responses, HTML forms, honeypot, Turnstile, allowed origins, limits | [docs/forms.md](./docs/forms.md) |
| Review messages: folders, search, export, deletion, retention | [docs/inbox.md](./docs/inbox.md) |
| Understand the scores, the reasons, and the processing | [docs/concepts.md](./docs/concepts.md) |
| Receive messages by webhook and verify the signature | [docs/webhooks.md](./docs/webhooks.md) |
| Receive messages by email with Resend or Cloudflare | [docs/email.md](./docs/email.md) |
| Read the inbox or send submissions from a server with an API token | [docs/api.md](./docs/api.md) |
| Connect an EmDash site | [docs/emdash.md](./docs/emdash.md) |
| Check health, recover stuck processing, restore D1, rotate secrets | [docs/operations.md](./docs/operations.md) |
| Measure the classifiers on a labeled corpus | [docs/evaluation.md](./docs/evaluation.md) |
| Run Rondyr on your machine | [docs/local-development.md](./docs/local-development.md) |
| Read what is built and why | [architecture.md](./architecture.md) |

## EmDash plugin

`@basaltbytes/emdash-plugin-rondyr`, in [`packages/emdash-plugin/`](./packages/emdash-plugin/), sends the submissions of an EmDash site's forms to Rondyr and shows the **Inbox**, **To review** and **Archived** folders in the EmDash admin, where editors decide without a Rondyr account. [docs/emdash.md](./docs/emdash.md) covers its installation.

## Local development

You need Node.js 24.22 or later and pnpm 11. Wrangler emulates D1, the queues, and the Durable Objects, so no Cloudflare account is needed.

```sh
pnpm install --frozen-lockfile
cp apps/rondyr/.env.example apps/rondyr/.env   # then set BETTER_AUTH_SECRET and RONDYR_SETUP_TOKEN
pnpm db:migrate
pnpm dev
```

[docs/local-development.md](./docs/local-development.md) covers the first account, a first message, and the checks (`pnpm check`, `pnpm deploy:dry`) that CI runs.

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](./CONTRIBUTING.md) describes the workflow, and [AGENTS.md](./AGENTS.md) the coding and writing rules, for people and coding agents alike.

## Security

Report a vulnerability privately through [GitHub's security advisories](https://github.com/basaltbytes/rondyr/security/advisories/new), not in an issue. [SECURITY.md](./SECURITY.md) lists what is in scope.

## License

Rondyr is licensed under the [GNU Affero General Public License v3.0](./LICENSE). You can run it, change it, and deploy it for your own forms. If you offer Rondyr, or software that includes it, to others over a network, you have to publish the complete source of that software under the same license.

These parts are under other licenses, each with its license file in the same directory:

- [`packages/emdash-plugin/`](./packages/emdash-plugin/): MIT, so that sites can compile the plugin into their own Worker.
- [`tooling/oxlint/`](./tooling/oxlint/): the 16 rules and 3 shared modules from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) listed in its README are under MIT, in `LICENSE-ANTI-SLOP`. The rest of the directory comes from usine and is under AGPL-3.0.
- [`apps/rondyr/dashboard/src/components/ui/`](./apps/rondyr/dashboard/src/components/ui/): the components derive from [shadcn/ui](https://github.com/shadcn-ui/ui), whose MIT notice is in `LICENSE-SHADCN`.
- [`.agents/skills/alchemy-domain/`](./.agents/skills/alchemy-domain/): copied from [Alchemy](https://github.com/alchemy-run/alchemy) under Apache-2.0, with its `LICENSE` and `NOTICE`.
- [`.agents/skills/effect-ts/references/schema-decisions.md`](./.agents/skills/effect-ts/references/schema-decisions.md): adapted from [artimath/effect-skills](https://github.com/artimath/effect-skills), whose MIT notice is in `LICENSE-EFFECT-SKILLS` next to it.

## Author

Rondyr is built by [Basaltbytes](https://basaltbytes.com).
