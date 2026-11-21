# EmDash plugin

`@basaltbytes/emdash-plugin-rondyr` connects an EmDash site to Rondyr. The site keeps `@emdash-cms/plugin-forms` to build, validate and display its forms. Each submission that the forms plugin accepts goes to Rondyr, which classifies it. Editors read the result in the EmDash admin, in **Messages**, and decide there without a Rondyr account. The notification email goes out through the site's own mailer, and only for messages that Rondyr accepts.

Rondyr is the source of truth. The plugin keeps a queue of submissions that Rondyr hasn't stored yet, the layout of each form for the emails, and nothing else: the **Messages** page reads the Rondyr API each time it opens.

The package is in this repository, under `packages/emdash-plugin/`, with the MIT license. It isn't on npm.

## Submission path

1. The site's contact form posts to the site route that the package exports, `/api/form`, with or without JavaScript, or to a route or page of the site that calls the package's `submitForm`.
2. The route calls the forms plugin's `submit` in the same Worker. The forms plugin validates the fields and stores its own copy, files included, as before.
3. When the forms plugin accepts, the route calls the Rondyr plugin's `enqueue` route, still in the same Worker, before it answers the visitor. The plugin writes a queue entry under a new submission ID.
4. Right after the response, the plugin sends the entry to `POST /f/{publicId}` on Rondyr with the API token and an `Idempotency-Key` equal to the submission ID ([server intake](./api.md#server-intake)). Rondyr's `202` deletes the entry.
5. Rondyr classifies the message. An accepted message, automatically or after a review, goes to the form's webhook: the site's `webhook` route checks the signature and sends one email per recipient through the site's mailer.

A quarantined message sends no email. Accepting it later, in EmDash or in the Rondyr dashboard, sends the emails then.

Only forms that post to `/api/form`, or to a site route that calls `submitForm`, go through Rondyr. The forms plugin's own **Form** block (`emdash-form`) posts straight to the forms plugin's `submit` route, so its submissions never reach the route or Rondyr; render those forms with a block that posts to `/api/form` instead.

## Requirements

- EmDash 1.5.0 or later, on Cloudflare: the plugin uses EmDash's conditional storage writes.
- `@emdash-cms/plugin-forms` 0.2.13 or later, `astro` 7, `react` 19 and `@cloudflare/kumo` 2.15, which the site already has with EmDash.
- An email provider plugin, such as the template's `resend-mailer`, so that `ctx.email` can send. Without one, accepted messages send no email and Rondyr's webhook deliveries fail and are retried.
- A deployed Rondyr stage reachable over HTTPS. EmDash refuses plugin requests to local and private addresses, so a site can't send to a Rondyr on `localhost`.

## Installation

### Rondyr

1. In the Rondyr dashboard, create an organization for the site, or open the existing one.
2. Add a form for each EmDash form that should go through Rondyr, and note its public ID. Rondyr's honeypot field, Turnstile and allowed origins don't matter here: a server intake skips Turnstile and the origin check, and the forms plugin keeps its own spam protection.
3. In **Settings → API tokens**, create a token named after the site, and copy it: Rondyr shows it once. This is `RONDYR_API_TOKEN`. Only an admin of the organization can create one. The token belongs to the admin who created it: removing that admin from the organization revokes it, and the site's sending stops until you set a new token: each submission gets `401` and is marked as failed in the queue, and **Retry failed submissions** sends them once the new token is set. The removal dialog says how many tokens go with the member.
4. In **Destinations**, add a webhook to each of these forms with the URL `https://<your site>/_emdash/api/plugins/rondyr/webhook`, and copy its signing secret, which Rondyr also shows once. Every form uses the same URL, and each webhook has its own secret: `RONDYR_WEBHOOK_SECRET` lists them all (see [Webhook secrets](#webhook-secrets)).

### Package

The repository is private, so installing from it needs read access to `basaltbytes/rondyr` over SSH, on your machine and in the site's CI:

```sh
pnpm add "git+ssh://git@github.com/basaltbytes/rondyr.git#main&path:/packages/emdash-plugin"
```

A checkout of this repository works too, with `pnpm add file:../rondyr/packages/emdash-plugin`. pnpm copies the directory when it installs, so after a change to the package, `pnpm install --force` brings the copy up to date.

The package has no dependencies of its own, only peer dependencies that the site already has, so a site with `blockExoticSubdeps` installs it from git or from a directory.

### `astro.config.mjs`

Replace `formsPlugin` with `formsWithoutSubmissions`, add `rondyr`, and declare the two secrets. The lines marked `// …` are the site's own configuration, which doesn't change:

```js
import { defineConfig, envField } from "astro/config";
import emdash from "emdash/astro";
import { formsWithoutSubmissions, rondyr } from "@basaltbytes/emdash-plugin-rondyr";
// …

export default defineConfig({
  // …
  integrations: [
    emdash({
      // …
      plugins: [
        formsWithoutSubmissions({ defaultSpamProtection: "honeypot" }),
        rondyr({ url: "https://rondyr.example.com" }),
        // … the site's mailer plugin, unchanged
      ],
    }),
  ],
  env: {
    schema: {
      // …
      RONDYR_API_TOKEN: envField.string({ context: "server", access: "secret", optional: true }),
      RONDYR_WEBHOOK_SECRET: envField.string({ context: "server", access: "secret", optional: true }),
    },
  },
});
```

`url` is the HTTPS origin of the Rondyr Worker; the plugin may call that host only.

`formsWithoutSubmissions` is the forms plugin without its **Submissions** page and its **Recent Submissions** widget: its copy of each submission becomes a backup, read only through **Rondyr settings** when something went wrong (see [Unqueued submissions](#unqueued-submissions)). Keep `formsPlugin` if editors should still see that copy, and shorten its retention in the form settings.

### Submission route

Replace `src/pages/api/form.ts`, or create it, with the package's route:

```ts
export { POST, prerender } from "@basaltbytes/emdash-plugin-rondyr/route";
```

The route takes two kinds of posts:

- With JavaScript: a JSON body `{ "formId": …, "data": { … }, "files": { … } }`, as the forms plugin's client script builds it. `formId` is the form's ID or slug. The answer is the forms plugin's JSON as its own route sends it, `{ "success": true, "data": … }` or `{ "success": false, "error": { "code", "message" } }`, with `200` when it accepted and `400` otherwise.
- Without JavaScript: a regular `multipart/form-data` or URL-encoded post with `formId`, the fields, and two optional fields: `_return`, a path on the site to come back to, and `_block`, a key for the form on that page. The answer is `303` to `_return?form=<_block>&status=sent` (or `status=error`), with `#<_block>-status`.

The route refuses a post whose `Origin` is another site with `403`. Every answer has `Cache-Control: private, no-store`, as the forms plugin's route has. Files go to the forms plugin, which stores them; Rondyr never gets them. In the EmDash site template, set `data-endpoint` to `/api/form` in `ContactForm.astro` so its script posts there.

#### A site's own route or page

A site that answers a post on a page of its own, for example a localized confirmation page for posts without JavaScript, calls `submitForm` from the same entry point instead:

```ts
import { submitForm } from "@basaltbytes/emdash-plugin-rondyr/route";

const posted = await Astro.request.formData();
const { accepted, answer } = await submitForm(Astro, { formId, data });
```

`submitForm` does what the route does between reading the post and answering: the forms plugin validates and stores the submission, and once it accepts, the submission is in the queue before `submitForm` returns. It takes Astro's `request`, `url` and `locals` (passing `Astro` works), and `{ formId, data, files? }` as the JSON route takes them. It reads the visitor's IP and country from the request's headers and never reads its body, so the page can read the posted form first. `accepted` is true when the forms plugin accepted, a filled honeypot field included, and `answer` is the forms plugin's JSON as the route would send it: `answer.data.message` and `answer.data.redirect` are the form's confirmation message and redirect. A post whose `Origin` is another site gets `accepted: false` with the error code `CROSS_SITE`, without reaching the forms plugin.

### Cron trigger

Retries run from the plugin's cron task, every minute, and EmDash runs plugin cron tasks from the Worker's Cron Trigger. The site's `wrangler.jsonc` needs:

```jsonc
{
  "main": "./src/worker.ts",
  "triggers": { "crons": ["* * * * *"] },
}
```

and `src/worker.ts`:

```ts
export { default, PluginBridge } from "@emdash-cms/cloudflare/worker";
```

`pnpm exec emdash doctor` checks this wiring, on its "scheduler wiring" line; on a D1 site it also reports that `./data.db` is missing, which is expected. Without the wiring, the attempt right after each response is the only one, and an entry that it doesn't send stays in the queue.

### Secrets

```sh
pnpm exec wrangler secret put RONDYR_API_TOKEN
pnpm exec wrangler secret put RONDYR_WEBHOOK_SECRET
```

Then deploy the site.

### EmDash admin

Open **Rondyr settings**, which only administrators can change. For each EmDash form, choose its Rondyr form and enter the notification recipients, one address per line, at most 20. The page shows the webhook URL to give Rondyr. Linking a form sends the submissions that were waiting for it.

Then, in **Forms**, remove the form's own notification emails and its auto-reply. Both go out the moment the forms plugin accepts a message, before Rondyr classifies it. The settings page warns about a linked form that still has either.

## Webhook secrets

Rondyr generates a secret for each webhook, so a site linked to several Rondyr forms receives webhooks signed with several secrets. `RONDYR_WEBHOOK_SECRET` contains all of them, separated by spaces, commas or line breaks, and the route accepts a request signed with any of them:

```sh
printf '%s' "whsec_contact… whsec_quotes…" | pnpm exec wrangler secret put RONDYR_WEBHOOK_SECRET
```

After **Rotate secret** in Rondyr, both secrets sign every request for 24 hours. Replace the old secret with the new one in `RONDYR_WEBHOOK_SECRET` and deploy the site within that window.

## Editor view

**Messages** has three folders, **Inbox** (accepted), **To review** (quarantined) and **Archived**, each with its count, a filter by form, and **Load more** for the next page. A message opens with all its fields. A message to review shows its reason in plain words, such as "Probable spam" or "Unsolicited sales outreach", and the **Accept** and **Archive** buttons. The dashboard widget shows how many messages wait for review.

Every role that can read plugin pages, from Editor up, can read the folders, decide, and retry failed submissions. **Rondyr settings** needs an administrator. The pages are in English or French, following the admin's language.

If Rondyr can't be reached, or refuses the token, the page says so and shows no message: nothing comes from a cache. A decision that fails hides the message until Rondyr answers again, since the decision may or may not have been recorded.

## Rondyr outages

A submission waits in the queue until Rondyr answers `202`. The first attempt runs right after the visitor's response. After a network error, a timeout of 30 seconds, `429` or a `5xx`, the next attempts follow after 1 minute, 5 minutes, 30 minutes, 2 hours, 6 hours, then every 6 hours; after 7 days in the queue the entry is marked as failed and stays. A `400`, `401`, `403` or `404` marks it as failed at once, with the status. An entry of an EmDash form without a Rondyr form waits as "not linked" until the form is linked.

Every attempt for a submission sends the same `Idempotency-Key`, so when an attempt times out after Rondyr stored the message, the next one gets the original submission back: no second message, no second email. Each attempt first claims its entry with a conditional write, so the attempt after the response, the cron and **Retry failed submissions** never send the same entry at once. A cron run sends at most 25 entries and starts none after a minute, which keeps a backlog under Rondyr's limit of 30 submissions a minute per form: after an outage, the queue drains at about 25 submissions a minute.

**Messages** shows a banner while the queue has pending, failed or unlinked entries, with their counts and **Retry failed submissions**, which makes failed entries due now with a new 7-day window.

## Unqueued submissions

If the queue itself can't be written, the forms plugin has already stored the submission, so the visitor still gets the success answer. The route tries `enqueue` a second time, then records the failure: the site's log gets `A submission accepted by the forms plugin could not be queued` with the form's slug and an error code, and the plugin counts it per form.

**Messages** then says how many submissions since which date are missing from Rondyr. In **Rondyr settings**, the form shows the count and the dates, **Download from the Forms plugin**, which downloads the forms plugin's CSV export of that form from 10 minutes before the first failure, and **Mark as handled**, which clears the warning. Rondyr doesn't have these submissions and sent no email for them, so read them in the export.

## Notification emails

On `submission.accepted`, the `webhook` route sends one email per recipient of each EmDash form linked to the Rondyr form, through `ctx.email.send`. The text follows the forms plugin's format, `New submission for "<form>"` and one `Label: value` line per field, with the labels of the last submission of that form. `Reply-To` is chosen as the forms plugin chooses it: the first filled email field of the form, a required one before an optional one, when its value is a plain address. A form with no filled email field falls back to a field named `email`.

The route answers `2xx` only once the mailer has taken every email. Otherwise it answers `503`, Rondyr retries the delivery, and the recipients already emailed for that delivery are skipped: the route records each recipient as soon as the mailer takes the email. While one request sends a delivery's emails, another request for the same delivery gets `503`. The route refuses a wrong signature and a timestamp more than 5 minutes away with `401`, and answers a delivery ID it has already processed with `2xx` and no email. A `test` request from the Rondyr dashboard gets `2xx` and sends nothing.

## Missing secrets

Both secrets are optional: the site builds and deploys without them, and the form still answers visitors.

- Without `RONDYR_API_TOKEN`, submissions wait in the queue, and **Messages** says the token is missing. Once it's set, the cron sends them. A value that isn't a Rondyr API token (`rdr_` and 43 more characters) counts as missing, and the admin pages say it's malformed.
- Without `RONDYR_WEBHOOK_SECRET`, the `webhook` route answers `503`, so Rondyr retries its deliveries for about nine hours, and no email goes out. The admin pages say what is missing.

## Security

- `enqueue` and `enqueue/failed` are public plugin routes, so that the site route can call them in the same Worker. They refuse a call whose `Authorization` header isn't `Bearer` followed by `RONDYR_API_TOKEN`, compared in constant time; on this hop the token doesn't leave the Worker. Without the token, the header must have a random 32-byte key that the Worker isolate creates on first use and never sends anywhere. The key is on `globalThis`, so the route and the plugin get the same one even when the build bundles them into separate chunks.
- The `webhook` route reads its body as bytes and checks the HMAC-SHA-256 signature over exactly those bytes, as [webhooks.md](./webhooks.md#signature) describes. During a secret rotation in Rondyr, either signature is accepted. The delivery ID is the payload's `deliveryId`, which the signature covers.
- The plugin may call the Rondyr host only (`allowedHosts`). Its log lines contain submission IDs, delivery IDs, form slugs, HTTP statuses and a category for a network error (`timeout`, `host-refused` or `network`), never the fields, the recipients or the token. `host-refused` means EmDash refused the call: a host missing from `allowedHosts`, or a local or private address.

## Design choices

- The forms plugin's `submit` returns no submission ID. The site route creates a UUID for each accepted submission, which is the queue entry's ID and the `Idempotency-Key`. A visitor who posts twice makes two messages, as with the forms plugin alone.
- A filled honeypot field (`_hp`) gets a silent success from the forms plugin, which stores nothing. The route doesn't send that submission to Rondyr either.
- Fields go to Rondyr by their name. Empty values, file fields and fields the form doesn't define (`_hp`, the Turnstile token) are left out. A list is joined with `, `, and numbers and booleans become text. Values come from the posted body, trimmed as the forms plugin trims what it stores, but not otherwise converted: a checkbox is `on`.
- Delivery IDs are kept for 30 days. Rondyr stops retrying a delivery after about nine hours.
