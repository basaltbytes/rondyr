# Connect an EmDash site

`@basaltbytes/emdash-plugin-rondyr` connects an [EmDash](https://emdash.dev) site to Rondyr. Your site keeps `@emdash-cms/plugin-forms` to build, validate, and render forms; Rondyr screens every submission for spam, editors review messages right inside EmDash under **Messages**, and notification emails (plus visitor auto-replies) go out through your site's own mailer only after Rondyr accepts a message.

Multiple EmDash forms (such as `contact-en` and `contact-fr`) can share one Rondyr form, one webhook, and one signing secret; each accepted message still goes to the recipients configured for the specific EmDash form the visitor used.

## Prerequisites

- EmDash `1.5.0` or later deployed on Cloudflare, with `@emdash-cms/plugin-forms` `0.2.13` or later.
- An email provider plugin on your EmDash site (such as `resend-mailer`) so your site can send emails.
- A deployed Rondyr instance reachable over HTTPS (EmDash blocks plugin calls to `localhost` or private addresses).

## 1. Set up Rondyr

1. In your Rondyr dashboard, open or create an organization for the site, and create a form (or one shared form for language variants). Copy its public ID from **Settings → Forms**. You don't need to configure Turnstile, allowed origins, or email destinations in Rondyr here; your EmDash site handles those.
2. In **Settings → API tokens**, create a token for your site and copy it once; this becomes `RONDYR_API_TOKEN`. Keep in mind that removing the admin who created a token revokes it, so create a replacement token before removing that admin.
3. In **Settings → Destinations**, add one webhook to each Rondyr form pointing to `https://<your-emdash-site>/_emdash/api/plugins/rondyr/webhook`, and copy its signing secret; this becomes `RONDYR_WEBHOOK_SECRET`.

## 2. Install and configure the plugin in EmDash

Install the package from GitHub, pinned to a commit hash from [`main`](https://github.com/basaltbytes/rondyr/commits/main/):

```sh
pnpm add "git+https://github.com/basaltbytes/rondyr.git#<commit>&path:/packages/emdash-plugin"
```

Update `astro.config.mjs` to replace `formsPlugin` with `formsWithoutSubmissions`, add `rondyr`, and declare both secrets:

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
        rondyr({ url: "https://forms.example.com" }),
        // … your site's mailer plugin
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

`formsWithoutSubmissions` hides the forms plugin's own **Submissions** menu and defers its immediate emails for forms linked to Rondyr. If you want editors to keep seeing the forms plugin's Submissions page as well, use `formsWithRondyr` instead. Don't keep the original `formsPlugin`, or it will send notifications and auto-replies before Rondyr filters spam.

## 3. Add the submission route and Cron Trigger

Create (or replace) `src/pages/api/form.ts` in your EmDash site:

```ts
export { POST, prerender } from "@basaltbytes/emdash-plugin-rondyr/route";
```

Point your form component at `/api/form` (for example, `data-endpoint="/api/form"` in `ContactForm.astro`). The route accepts both JavaScript JSON submissions and plain HTML form posts (`multipart/form-data` or URL-encoded, with optional `_return` and `_block` fields for redirecting back with `?form=<_block>&status=sent`). File uploads stay in the forms plugin and aren't sent to Rondyr.

Note that the forms plugin's built-in **Form** block (`emdash-form`) posts straight to the forms plugin's own endpoint and bypasses Rondyr; use a form component that posts to `/api/form` (or calls `submitForm` from `@basaltbytes/emdash-plugin-rondyr/route` in your own Astro page).

To enable automatic retries if Rondyr is briefly unreachable, add a Cron Trigger in your EmDash site's `wrangler.jsonc` and export `PluginBridge` from `src/worker.ts`:

```jsonc
{
  "main": "./src/worker.ts",
  "triggers": { "crons": ["* * * * *"] },
}
```

```ts
export { default, PluginBridge } from "@emdash-cms/cloudflare/worker";
```

## 4. Deploy and link your forms

Upload the two secrets to your EmDash site and deploy:

```sh
pnpm exec wrangler secret put RONDYR_API_TOKEN
pnpm exec wrangler secret put RONDYR_WEBHOOK_SECRET
```

If your site uses more than one Rondyr form, put all their webhook secrets into `RONDYR_WEBHOOK_SECRET` separated by spaces, commas, or line breaks:

```sh
printf '%s' "whsec_contact… whsec_quotes…" | pnpm exec wrangler secret put RONDYR_WEBHOOK_SECRET
```

After deploying, open **Rondyr settings** in the EmDash admin (administrators only):

1. Pick the Rondyr form for each EmDash form you want filtered.
2. Enter the notification recipients for each EmDash form (one email address per line, up to 20).
3. Save. Any submissions already waiting for that form are sent to Rondyr right away.

## Using Rondyr in EmDash

- **Messages and widget.** Editors (anyone with plugin read access) see **Inbox**, **To review**, and **Archived** under **Messages** in the EmDash admin, with form filters and **Accept** / **Archive** buttons, plus a dashboard widget showing how many messages wait for review. Nothing is cached locally; **Messages** reads live from Rondyr.
- **Notification emails and auto-replies.** For a linked form posted through `/api/form`, the forms plugin's own notification, daily digest, and auto-reply don't go out on arrival. Once Rondyr accepts the message (automatically or after review), your site's mailer sends one formatted email per recipient listed in **Rondyr settings**, plus the form's auto-reply to the visitor if you turned auto-replies on in **Forms**. Forms that aren't linked to Rondyr keep their usual forms-plugin email behavior.
- **Rotating webhook secrets.** When you select **Rotate secret** in Rondyr, both secrets remain valid for 24 hours; replace the old secret in `RONDYR_WEBHOOK_SECRET` and redeploy your EmDash site within that window.
- **Handling outages.** If Rondyr is temporarily unreachable, your site still accepts the visitor's form and retries sending to Rondyr automatically for up to 7 days, using an idempotency key so messages are never duplicated. **Messages** displays a banner with counts of pending or failed items and a **Retry failed submissions** button. If local storage failed before a submission could be held for retry, **Rondyr settings** shows how many messages were missed and offers a **Download from the Forms plugin** CSV button so you don't lose them.
- **Missing secrets.** Your site still builds and accepts form submissions if either secret is missing; **Messages** and **Rondyr settings** show a clear warning until you add them.
