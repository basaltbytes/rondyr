# Connect an EmDash site

`@basaltbytes/emdash-plugin-rondyr` connects an [EmDash](https://emdash.dev) site to Rondyr. Visitors post to your site. Rondyr screens messages, and editors review them in EmDash under **Messages**. Your site's mailer sends notifications after Rondyr accepts a message.

| Mode | Use it when |
| --- | --- |
| Declared forms, `rondyr({ url, forms })` | You render forms in Astro and translate their text on the site. One declaration serves all locales, and you set Turnstile in Rondyr. |
| Forms plugin, `rondyr({ url })` | Editors build forms in the EmDash admin or visitors need attachments. The forms plugin validates and stores each post before Rondyr receives its text fields. |

Multiple EmDash forms (such as `contact-en` and `contact-fr`) can share one Rondyr form, one webhook, and one signing secret; each accepted message still goes to the recipients configured for the specific EmDash form the visitor used.

## Prerequisites

- EmDash `1.5.0` or later deployed on Cloudflare.
- An email provider plugin on your EmDash site (such as `resend-mailer`) so your site can send emails.
- A deployed Rondyr instance reachable over HTTPS (EmDash blocks plugin calls to `localhost` or private addresses).

## 1. Set up Rondyr

1. In your Rondyr dashboard, open or create an organization for the site, and create a form (or one shared form for language variants). For a declared form that uses Turnstile, save the widget’s site and secret keys in the Rondyr dashboard, on the form's page, under **Turnstile**. In forms plugin mode, configure Turnstile in EmDash.
2. In **Settings → API tokens** (`/o/<organization ID>/settings/api-tokens` in the dashboard), create a token for your site and copy it once; this becomes `RONDYR_API_TOKEN`. Keep in mind that removing the admin who created a token revokes it, so create a replacement token before removing that admin.
3. On the page of each Rondyr form (`/o/<organization ID>/forms/<form ID>`), under **Destinations**, add one webhook pointing to `https://<your-emdash-site>/_emdash/api/plugins/rondyr/webhook`, and copy its signing secret; this becomes `RONDYR_WEBHOOK_SECRET`.

## 2. Install and configure the plugin in EmDash

Install the package from GitHub, pinned to a commit hash from [`main`](https://github.com/basaltbytes/rondyr/commits/main/):

```sh
pnpm add "git+https://github.com/basaltbytes/rondyr.git#<commit>&path:/packages/emdash-plugin"
```

### Declared forms

Add `rondyr({ url, forms })` to your EmDash plugins in `astro.config.mjs` and declare the two secrets as shown below. The form declarations must be JSON-serializable.

```js
import { rondyr } from "@basaltbytes/emdash-plugin-rondyr";

const contactForms = rondyr({
  url: "https://forms.example.com",
  forms: [
    {
      slug: "contact",
      name: "Contact",
      spamProtection: "turnstile",
      fields: [
        { name: "email", type: "email", required: true, labels: { en: "Email", fr: "Courriel" } },
        {
          name: "message",
          type: "textarea",
          required: true,
          maxLength: 3000,
          labels: { en: "Your project", fr: "Votre projet" },
        },
      ],
    },
  ],
});
```

Include `contactForms` in the `plugins` array you pass to `emdash()`. The field types are `text`, `email`, `tel`, `url`, `textarea`, `select`, `checkbox`, and `hidden`. A select takes an `options` array of strings. A required checkbox must be checked. Add `autoReply: { subject, text }` to a form to email the visitor after Rondyr accepts the message. The first filled required email field takes precedence over optional email fields.

### Forms plugin

Install `@emdash-cms/plugin-forms` `0.2.13` or later as well. Replace `formsPlugin` with `formsWithoutSubmissions` and add `rondyr({ url })`. Both modes use the same two secrets in `env.schema`.

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

Point your form component at `/api/form`. In either mode the route takes JSON `{ formId, data }` and plain HTML form posts with a hidden `formId` input and named fields. HTML posts redirect with `303`. Set `_return` to a same-site path and `_block` to a form anchor to get `?form=<_block>&status=sent|error#<_block>-status`.

In declared mode, use the form slug as `formId`. Pass the page locale in the `_locale` field in HTML (`data._locale` or a top-level `locale` for JSON and `submitForm`). The notification chooses each field’s label from that locale, its base language, English, then the field name. Render the page with your site's translations. Unknown fields are discarded. A JSON post with an attachment returns `400`, and an HTML post with an attachment redirects to the error state. A JSON validation failure has `success: false` and `error: { code, message }`, with the list of `{ field, message }` items in `data.errors` when fields need correction.

For the field rules and widget key, read the form in a server-rendered Astro page:

```astro
---
import { getDeclaredForm } from "@basaltbytes/emdash-plugin-rondyr/route";

const form = await getDeclaredForm(Astro, "contact");
---
```

`getDeclaredForm` returns `null` for an unknown slug. A form configured with `spamProtection: "honeypot"` can render a hidden-from-visitors `_hp` input. If this field is filled, the site answers with a silent success. For `spamProtection: "turnstile"`, render the [Turnstile widget](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/) with `form.turnstileSiteKey` and include its `cf-turnstile-response` in the post. The linked Rondyr form supplies the site key. It is `null` until the link and keys are configured. The plugin caches the Rondyr form list for three minutes. If Rondyr can't be reached or `RONDYR_API_TOKEN` is missing, the page still renders: `form.turnstileSiteKey` is the last key the plugin read, or `null` before a first read, and the plugin asks Rondyr again 30 seconds later. Render the form without the widget when the key is `null`. Rondyr puts messages whose token is missing, refused, or expired in **To review**.

In forms plugin mode, the forms plugin keeps file uploads in its own storage and forwards the text fields through Rondyr.

The forms plugin's built-in **Form** block (`emdash-form`) posts straight to the forms plugin's own endpoint and bypasses Rondyr. Use a form component that posts to `/api/form` (or calls `submitForm` from `@basaltbytes/emdash-plugin-rondyr/route` in your own Astro page).

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
- **Notification emails and auto-replies.** Once Rondyr accepts a message, your site’s mailer sends one email per recipient listed in **Rondyr settings**, plus an auto-reply when configured. In forms plugin mode, notifications and digests from linked forms posted to `/api/form` are replaced by these emails. Unlinked forms keep their usual Forms emails.
- **Rotating webhook secrets.** When you select **Rotate secret** in Rondyr, both secrets remain valid for 24 hours; replace the old secret in `RONDYR_WEBHOOK_SECRET` and redeploy your EmDash site within that window.
- **Handling outages.** If Rondyr is temporarily unreachable, your site still accepts the visitor's form and retries sending to Rondyr automatically for up to 7 days, using an idempotency key so messages are never duplicated. **Messages** displays a banner with counts of pending or failed items and a **Retry failed submissions** button. A declared form confirms the post after the site saves it and removes its local copy once Rondyr returns `202`. In forms plugin mode, if a message could not be saved for forwarding, **Rondyr settings** offers a **Download from the Forms plugin** CSV button.
- **Missing secrets.** Your site still builds and accepts form submissions if either secret is missing; **Messages** and **Rondyr settings** show a clear warning until you add them.

## Move from the forms plugin to declared forms

1. Check **Messages** for pending, failed, and unlinked submissions. Keep their slugs linked while they drain, and retry failed messages. Pending messages carry over between modes and keep their original delivery and auto-reply behavior.
2. Review any warnings about messages that could not be forwarded or bypassed Rondyr in **Rondyr settings**. Export those messages before removing the forms plugin. If you need a complete archive of submissions or attachments, export the old submissions in **Forms** and retain their attachment files. Turning off the plugin leaves its stored submissions in the EmDash database. They don't appear in Rondyr unless they were forwarded.
3. Declare the forms with their existing slugs to keep the Rondyr links and recipients. If you combine language-specific forms under one slug, keep the one whose link you want to reuse, and check that its recipients and destination are correct. Use `_locale` on each page.
4. Point forms at `/api/form` and replace any built-in EmDash Form blocks. Move the Turnstile keys to the linked Rondyr form and render with its site key. Deploy with `rondyr({ url, forms })` as the form integration. Keep the site's API token, signing secret, and Cron Trigger.
