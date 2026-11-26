# rondyr

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
