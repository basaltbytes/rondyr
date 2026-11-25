# @basaltbytes/emdash-plugin-rondyr

## 0.1.0

### Minor Changes

Initial release of the MIT-licensed EmDash plugin for Rondyr.

- **Two form modes:** declared Astro forms via `rondyr({ url, forms })` with per-locale field labels, honeypot or Turnstile widgets (`getDeclaredForm`), and optional auto-replies; or `@emdash-cms/plugin-forms` integration via `formsWithoutSubmissions` and `formsWithRondyr`.
- **Submission route and outage retries:** `/api/form` route (`POST` and `submitForm`) for HTML and JSON posts, with local queueing and Cron Trigger retries using idempotency keys when Rondyr is unreachable.
- **EmDash admin inbox and settings:** live **Messages** views (**Inbox**, **To review**, **Archived**) with accept/archive actions, a review-count dashboard widget, and **Rondyr settings** for linking forms and configuring notification recipients.
- **Signed webhook intake:** verifies Rondyr webhook signatures (including 24-hour secret rotation windows) before sending site notification emails and auto-replies through the EmDash mailer.
