# EmDash plugin

`@basaltbytes/emdash-plugin-rondyr` connects an EmDash site to Rondyr. The site keeps `@emdash-cms/plugin-forms` to build, validate and display its forms. Each submission that the forms plugin accepts goes to Rondyr, which classifies it. Editors read the result in the EmDash admin, in **Messages**, and decide there without a Rondyr account. The notification email goes out through the site's own mailer, and only for messages that Rondyr accepts.

Rondyr stays the source of truth. The plugin keeps a queue of submissions that Rondyr hasn't stored yet, and nothing else: the **Messages** page reads the Rondyr API each time it opens.

The package lives in this repository, under `packages/emdash-plugin/`, with the MIT license. It is not on npm yet.

## How a submission travels

1. The contact block posts to the site route that the package exports, with or without JavaScript.
2. The route calls the forms plugin's `submit` in the same Worker. The forms plugin validates the fields and stores its own copy, as before.
3. When the forms plugin accepts, the route calls the Rondyr plugin's `enqueue` route, still in the same Worker, before it answers the visitor. The plugin writes a queue entry keyed by a new submission ID, and answers.
4. Right after the response, the plugin sends the entry to `POST /f/{publicId}` on Rondyr with the API token and an `Idempotency-Key` equal to the submission ID ([server intake](./api.md#server-intake)). A `202` deletes the entry.
5. Rondyr classifies the message. An accepted message, automatically or after a review, goes to the form's webhook: the site's `webhook` route checks the signature and sends one email per recipient through the site's mailer.

A quarantined message sends no email. Accepting it later, in EmDash or in the Rondyr dashboard, sends the emails then.

## Install

### In Rondyr

1. Create the organization and a form for each EmDash form that should go through Rondyr. Rondyr's honeypot field, Turnstile and allowed origins don't matter here: a server intake skips Turnstile and the origin check, and the forms plugin keeps its own protection.
2. In **Settings → API tokens**, create a token named after the site. Copy it: Rondyr shows it once.
3. In **Destinations**, add a webhook to each linked form, with the URL `https://<your site>/_emdash/api/plugins/rondyr/webhook`. Copy its signing secret.

### In the site

Install the package from this repository until it is on npm:

```sh
pnpm add "github:basaltbytes/rondyr#main&path:packages/emdash-plugin"
```

In `astro.config.mjs`, replace `formsPlugin` with `formsWithoutSubmissions`, add `rondyr`, and declare the two secrets:

```js
import { formsWithoutSubmissions, rondyr } from "@basaltbytes/emdash-plugin-rondyr";

export default defineConfig({
  integrations: [
    emdash({
      plugins: [
        formsWithoutSubmissions({ defaultSpamProtection: "honeypot" }),
        rondyr({ url: "https://rondyr.example.com" }),
        resendMailer({ siteUrl: `https://${site.host}`, ...site.mail }),
      ],
    }),
  ],
  env: {
    schema: {
      RONDYR_API_TOKEN: envField.string({ context: "server", access: "secret", optional: true }),
      RONDYR_WEBHOOK_SECRET: envField.string({ context: "server", access: "secret", optional: true }),
    },
  },
});
```

`url` is the origin of the Rondyr Worker; the plugin may call that host only. `formsWithoutSubmissions` is the forms plugin without its **Submissions** page and its **Recent Submissions** widget, whose copy becomes a backup. Keep `formsPlugin` if editors should still see that copy, and shorten its retention in the form settings.

Replace `src/pages/api/form.ts` with the package's route:

```ts
export { POST, prerender } from "@basaltbytes/emdash-plugin-rondyr/route";
```

The route answers a JavaScript post (`{ formId, data }` as JSON) with the forms plugin's JSON, and a post without JavaScript with a redirect to the page, `?form=<block>&status=sent|error`, as the template's route did. In `ContactForm.astro`, set `data-endpoint` to `/api/form`, so the script posts there rather than to the forms plugin.

Set the secrets, then deploy:

```sh
pnpm exec wrangler secret put RONDYR_API_TOKEN
pnpm exec wrangler secret put RONDYR_WEBHOOK_SECRET
```

The site needs its cron trigger, `* * * * *` in the template's `wrangler.jsonc`: the plugin's retries run from it.

### In the EmDash admin

Open **Rondyr settings**, which only administrators can change. For each EmDash form, choose its Rondyr form and enter the notification recipients, one address per line. The page shows the webhook URL to give Rondyr.

Then, in **Forms**, remove the form's own notification emails and its auto-reply. Both go out the moment the forms plugin accepts a message, before Rondyr classifies it. The settings page warns about a linked form that still has either.

## What editors see

**Messages** has three folders, **Inbox** (accepted), **To review** (quarantined) and **Archived**, each with its count, a filter by form, and **Load more** for the next page. A message opens with all its fields. A message to review shows its reason in plain words, such as "Probable spam" or "Unsolicited sales outreach", and the **Accept** and **Archive** buttons. The dashboard widget shows how many messages wait for review.

Every role that can read plugin pages, from Editor up, can read the folders and decide. The page is in English or French, following the admin's language.

If Rondyr can't be reached, or refuses the token, the page says so and shows no message: nothing comes from a cache.

## When Rondyr is unreachable

A submission waits in the queue until Rondyr answers `202`. The first attempt runs right after the visitor's response; after a network error, a timeout, `429` or a `5xx`, the next attempts follow after 1 minute, 5 minutes, 30 minutes, 2 hours, 6 hours, then every 6 hours. After 7 days in the queue the entry is marked as failed and stays. A `400`, `401`, `403` or `404` marks it as failed at once, with the status. An entry of an EmDash form without a Rondyr form waits as "not linked", and goes out once the form is linked.

Every attempt carries the same `Idempotency-Key`, so a first attempt that timed out after Rondyr stored the message gets the original submission back on the next attempt: no second message, no second email. An hour-long outage loses nothing and duplicates nothing.

**Messages** shows a banner while the queue holds pending, failed or unlinked entries, with their counts and **Retry failed submissions**, which makes failed entries due now with a new 7-day window. The forms plugin keeps its own copy of every submission in any case.

## Notification emails

On `submission.accepted`, the `webhook` route sends one email per recipient of each EmDash form linked to the Rondyr form, through `ctx.email.send`. The text follows the forms plugin's format, `New submission for "<form>"` and one `Label: value` line per field, with the labels of the last submission of that form. A valid address in the form's email field becomes `Reply-To`.

The route answers `2xx` only once the mailer has taken every email. Otherwise Rondyr retries the delivery, and the recipients already emailed for that delivery ID are skipped. The route refuses a wrong signature (`401`), a timestamp more than 5 minutes away (`401`) and does nothing for a delivery ID it has already processed. A `test` request from the Rondyr dashboard gets `2xx` and sends nothing.

## Without the secrets

Both secrets are optional: the site builds and deploys without them, and the form still answers visitors.

- Without `RONDYR_API_TOKEN`, submissions wait in the queue, and **Messages** says the token is missing. Once the token is set, the cron sends them.
- Without `RONDYR_WEBHOOK_SECRET`, the `webhook` route answers `503`, so Rondyr retries its deliveries for about nine hours, and no email goes out. The admin pages say what is missing.

## Security

- `enqueue` is a public plugin route, so that the site route can call it in the same Worker. It refuses a call whose `Authorization` header is not `Bearer` followed by `RONDYR_API_TOKEN`. On this hop the token stays inside the Worker. Without the token, the header must carry a random key that the Worker isolate creates and never sends anywhere.
- The `webhook` route reads its body as bytes, and checks the HMAC-SHA-256 signature over exactly those bytes, as [webhooks.md](./webhooks.md#signature) describes. During a secret rotation in Rondyr, either signature is accepted.
- The plugin may call the Rondyr host only (`allowedHosts`). It logs submission IDs and HTTP statuses, never the fields.

## Choices the issue left open

- The forms plugin's `submit` returns no submission ID. The site route creates a UUID for each accepted submission, which keys the queue entry and becomes the `Idempotency-Key`.
- A filled honeypot field (`_hp`) gets a silent success from the forms plugin, which stores nothing. The route doesn't send that submission to Rondyr either.
- Fields go to Rondyr by their name. Empty values, file fields and fields the form doesn't define (`_hp`, the Turnstile token) are left out. A list is joined with `, `.
