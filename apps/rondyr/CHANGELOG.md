# rondyr

## 0.3.0

### Minor Changes

- [#129](https://github.com/basaltbytes/rondyr/pull/129) [`a9c9e2d`](https://github.com/basaltbytes/rondyr/commit/a9c9e2dc630ca3be2206e75ead563b800a3396c8) Thanks [@PhilDL](https://github.com/PhilDL)! - Replace password authentication and `better-auth` with passwordless Passkeys (`@oslojs/webauthn` + Web Crypto), conditional Email OTP sign-in, `RONDYR_RECOVERY_TOKEN` recovery and custom-domain migration, and an Account Security passkey manager, enabling one-click test-drives on Cloudflare Workers Free within the 10 ms CPU limit.
  
  **Upgrading an existing instance:** this release deletes the stored passwords, and everyone signs in again. With an email provider configured, sign in with an email code and add a passkey in **Account → Security**. Without one, set the `RONDYR_RECOVERY_TOKEN` secret (at least 32 characters), use **Recover access** on `/sign-in` for each account, then delete the secret. See "Update from a version that signed in with passwords" in `docs/deployment.md`.

### Patch Changes

- [#137](https://github.com/basaltbytes/rondyr/pull/137) [`2a50edf`](https://github.com/basaltbytes/rondyr/commit/2a50edf8b245e16dd9e0e88fb3788e1f0e34c230) Thanks [@PhilDL](https://github.com/PhilDL)! - Tidy the page of a form: the name and the description have more room when they are edited in place, the blocked words are a setting next to the honeypot field and Turnstile, the allowed origins come before the destinations, and every multi-line field has less round corners.

- [#132](https://github.com/basaltbytes/rondyr/pull/132) [`fde9769`](https://github.com/basaltbytes/rondyr/commit/fde976977977a96f777b5d92da80d8ff27bf0340) Thanks [@PhilDL](https://github.com/PhilDL)! - Send multipart HTML and plain-text transactional emails (Email OTP sign-in codes, team invitations, recipient confirmations, form deliveries, and test messages) in English and French using a shared Rondyr email layout.

## 0.2.0

### Minor Changes

- [#116](https://github.com/basaltbytes/rondyr/pull/116) [`39ec4b2`](https://github.com/basaltbytes/rondyr/commit/39ec4b2e0b698bc32c0fe9a12aecf4e73ea39631) Thanks [@PhilDL](https://github.com/PhilDL)! - Show how the screening treated each inbox message: one sentence on why it sits in its folder, then every reception check and AI rule in one table, with an icon for each kind of check and each AI score drawn on a bar against its thresholds. The processing history and the Effect trace IDs sit under a disclosure. Admins can test an existing message with the current form descriptions, blocked words, domains and classification settings: the result appears as a second column beside what happened on arrival, without changing the message's status, history or deliveries.

### Patch Changes

- [#127](https://github.com/basaltbytes/rondyr/pull/127) [`09f3b7d`](https://github.com/basaltbytes/rondyr/commit/09f3b7d3900cd81776ca2f3cefecdb5e394350c3) Thanks [@PhilDL](https://github.com/PhilDL)! - Fold a message's Classification and Deliveries at the foot of the reader. Each folded row shows the verdict or the delivery statuses; one panel opens at a time, grows upward with a shadow over the message, and stays open from one message to the next, while the message scrolls in the room above it. The refresh button of the deliveries has a tooltip. On a wide screen the page no longer bounces past the app when a pane reaches its end, and the classification table no longer scrolls sideways by a few pixels after a test.

- [#119](https://github.com/basaltbytes/rondyr/pull/119) [`1c8a826`](https://github.com/basaltbytes/rondyr/commit/1c8a826367d3a7455619840941b8edb6f0e16d91) Thanks [@PhilDL](https://github.com/PhilDL)! - Name each classification concept one way across the dashboard. A message that the classification holds back goes to review ("To review" / « À vérifier »), never "quarantined" or "set aside"; the model step is the AI analysis. The section under each message and the settings group are called Classification. A reason has the same words and the same icon in the message list, the reader, the classification table, the Status page and the AI analysis settings.

## 0.1.0

### Minor Changes

Initial pre-alpha release of Rondyr, a self-hosted form backend with spam filtering on Cloudflare Workers, D1, Queues, and Durable Objects.

- **Intake and bot defenses:** plain HTML `<form>` posts, cross-origin JSON `fetch`, and authenticated server intake with idempotency keys. Includes per-client and per-form rate limits, honeypot fields, Cloudflare Turnstile verification, allowed origins, repeat detection, form and organization blocked terms, and per-organization daily quotas.
- **Spam classification:** classifies messages for spam, unsolicited sales pitches, and relevance to your business using Jev on Workers AI by default or OpenAI Decisions via Cloudflare AI Gateway, with optional second-model escalation for uncertain messages. Doubtful messages stay in **To review** with a plain reason instead of being dropped.
- **Forwarding and connectors:** sends accepted messages by email (Resend or Cloudflare Email Sending, to confirmed recipients), HMAC-SHA-256 signed webhooks with secret rotation, and Discord, Slack, or Airtable connectors, with automatic retries and delivery logs.
- **Dashboard and team management:** English and French interface with owner setup flow, **Admin** and **Reviewer** roles, invitations, inbox search, CSV and JSON Lines export, deletion, and retention rules.
- **Deployment:** one-click Deploy to Cloudflare button with Workers Builds, Alchemy deployment path via GitHub Actions, and the **Update Rondyr** workflow for button copies.
