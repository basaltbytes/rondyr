# Costs and limits

Rondyr is free and open source, so you only pay Cloudflare (and your email provider, if you use Resend) for what your instance uses. You can deploy and test-drive Rondyr on **Workers Free** with one click. For production sites, use **Workers Paid** ($5/month per Cloudflare account).

For most small and medium sites, the $5/month Cloudflare plan plus the free email allowance covers everything with plenty of headroom.

## Workers Free vs. Workers Paid

Passkeys and Email OTP run well under the 10 ms CPU limit, so the Deploy to Cloudflare button works end to end on a **Workers Free** account with the default `wrangler.json` configuration. Keep these free tier limits in mind:

- **Background delivery & retries (10,000 operations/day).** Background classification and delivery retries count toward this daily cap. A busy form or a spam burst can exhaust it before midnight UTC.
- **Workflow state (100,000 requests and 100,000 row writes/day).** Submission workflows and the inbox view store their state in Cloudflare workflow storage. Low-traffic testing fits easily; steady production traffic does not.
- **CPU time (10 ms per request).** Single sign-ins, dashboard reads, and individual form submissions finish well below 10 ms, but full 10-message processing batches or large CSV/JSONL exports can exceed 10 ms on Free.
- **Workers AI (10,000 Neurons/day) and `typesafe/jev`.** Cloudflare includes 10,000 free Neurons/day on Workers Free for standard open-weight models. However, `typesafe/jev` (Rondyr's default classifier) is a partner model that requires a paid billing setup or AI Gateway credits on Cloudflare rather than drawing from the standard free Neuron pool. If Workers AI refuses calls on a Free account, Rondyr still saves every submission and places it in **To review** with **Analysis unavailable** so no message is lost.
- **Cloudflare Email Sending.** On Workers Free, outbound email through Cloudflare Email Sending is restricted to destination addresses verified in your Cloudflare account. Resend's free tier can send to any confirmed recipient address.

Upgrade to **Workers Paid** ($5/month) before putting a live production site on Rondyr.

## Cloudflare pricing

Cloudflare bills per account, not per form. Prices and included allowances change from time to time; check the linked Cloudflare pages before relying on the November 2026 numbers below.

| Service | Included with Workers Paid ($5/month) | Overage rate |
| --- | --- | --- |
| [Workers](https://developers.cloudflare.com/workers/platform/pricing/) | 10 million requests and 30 million CPU ms/month | $0.30 per million requests, $0.02 per million CPU ms |
| [Database storage](https://developers.cloudflare.com/d1/platform/pricing/) | 25 billion rows read, 50 million rows written, 5 GB storage/month | $0.001 per million reads, $1.00 per million writes, $0.75 per GB-month |
| [Background delivery & retries](https://developers.cloudflare.com/queues/platform/pricing/) | 1 million operations/month | $0.40 per million operations |
| [Workflow state](https://developers.cloudflare.com/durable-objects/platform/pricing/) | 1 million requests and 400,000 GB-s/month | $0.15 per million requests, $12.50 per million GB-s |
| [Workers AI](https://developers.cloudflare.com/workers-ai/platform/pricing/) (Jev classifier, default) | 10,000 Neurons/day | $0.011 per 1,000 Neurons |
| [AI Gateway unified billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/) (OpenAI Decisions, optional) | Prepaid credits, billed per call | Depends on model token usage |
| [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) | 20 million log events/month, 7-day retention | $0.60 per million events |

Even with zero form traffic, Rondyr runs a once-per-minute health and retry check (1,440 lightweight runs per day), which stays far below the included monthly allowances. Each trial copy you deploy in the same account adds its own baseline usage.

## Email provider costs

You only need an email provider if you want Rondyr to send notification emails, team invitations, or Email OTP sign-in codes.

- **Resend (default).** Free tier includes 3,000 emails per month (up to 100 per day) from up to 3 domains. Paid plans start at $20/month for 50,000 emails with no daily cap. Each recipient on an email destination counts as one email. See [Resend pricing](https://resend.com/pricing).
- **Cloudflare Email Sending.** Workers Paid includes 3,000 outbound emails per month per account, then $0.35 per 1,000 emails. Sends to addresses already verified in your Cloudflare account don't count toward the quota. See [Cloudflare Email Sending pricing](https://developers.cloudflare.com/email-service/platform/pricing/).

## Control spending with daily quotas

Your main lever over AI classification costs is **Settings → Daily quotas**, which caps how many submissions and AI classifications an organization can use per UTC day.

![Settings Daily quotas screen showing daily submission limit, daily classification limit, and junk caught at intake](./screenshots/quotas.webp)

By default, each organization gets:

- **2,000 stored submissions per day** (configurable from 1 to 100,000)
- **1,000 AI classifications per day** (configurable from 0 to 100,000)
- **2,000 junk submissions caught at intake per day** (matches the submission limit)

Junk caught before AI analysis (messages that fill your honeypot field, fail Turnstile, or repeat earlier submissions) uses its own separate daily allowance so a bot attack doesn't lock out real visitors or burn your AI budget. Once an organization hits its daily classification limit, real submissions are still saved and placed in **To review** instead of calling the AI model.

To keep an eye on real spend, check usage in your Cloudflare dashboard under **Workers & Pages** and **AI**, and turn on Cloudflare billing notifications for your account.
