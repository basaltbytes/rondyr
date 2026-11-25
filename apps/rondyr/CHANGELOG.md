# rondyr

## 0.1.0

### Minor Changes

Initial pre-alpha release of Rondyr, a self-hosted form backend with spam filtering on Cloudflare Workers, D1, Queues, and Durable Objects.

- **Intake and bot defenses:** plain HTML `<form>` posts, cross-origin JSON `fetch`, and authenticated server intake with idempotency keys. Includes per-client and per-form rate limits, honeypot fields, Cloudflare Turnstile verification, allowed origins, repeat detection, form and organization blocked terms, and per-organization daily quotas.
- **Spam classification:** classifies messages for spam, unsolicited sales pitches, and relevance to your business using Jev on Workers AI by default or OpenAI Decisions via Cloudflare AI Gateway, with optional second-model escalation for uncertain messages. Doubtful messages stay in **To review** with a plain reason instead of being dropped.
- **Forwarding and connectors:** sends accepted messages by email (Resend or Cloudflare Email Sending, to confirmed recipients), HMAC-SHA-256 signed webhooks with secret rotation, and Discord, Slack, or Airtable connectors, with automatic retries and delivery logs.
- **Dashboard and team management:** English and French interface with owner setup flow, **Admin** and **Reviewer** roles, invitations, inbox search, CSV and JSON Lines export, deletion, and retention rules.
- **Deployment:** one-click Deploy to Cloudflare button with Workers Builds, Alchemy deployment path via GitHub Actions, and the **Update Rondyr** workflow for button copies.
