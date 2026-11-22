// The text of the landing page shared by the hero component, the page, and structured data.

/** Metadata for the landing page, shared between index.astro, OpenGraph, and llms.txt. */
export const landingMeta = {
  title: "Rondyr: Open-Source Self-Hosted Form Backend for Cloudflare",
  description:
    "Open-source, self-hosted form backend with classifier-model spam filtering (Jev and OpenAI Decisions). Deploy in one click to your Cloudflare account.",
  ogImageAlt:
    "Rondyr: open-source, self-hosted form backend with classifier-model spam filtering on Cloudflare",
} as const;

/** Cloudflare's one-click deploy link for the public repository. */
export const deployUrl =
  "https://deploy.workers.cloudflare.com/?url=https://github.com/basaltbytes/rondyr";

export interface FirstRunStep {
  readonly title: string;
  /** One paragraph of HTML. */
  readonly html: string;
}

export const firstRun: readonly FirstRunStep[] = [
  {
    title: "Deploy in one click",
    html: "Select <strong>Deploy to Cloudflare</strong>. Cloudflare copies the repository to your GitHub or GitLab account and deploys Rondyr to your Cloudflare account. When it asks for the setup token, enter a long random passphrase of at least 32 characters (for example from your password manager or <code>openssl rand -hex 32</code>) and keep it for the next step.",
  },
  {
    title: "Create the owner account",
    html: "Open your new Rondyr address and create the first account with that setup token. Public sign-up stays closed; other people join your organization through an invitation link.",
  },
  {
    title: "Connect a form",
    html: "Create an organization and a form in the dashboard, then paste the form's URL into the <code>action</code> attribute of a <code>&lt;form&gt;</code> on your site.",
  },
];

export interface FaqItem {
  readonly question: string;
  /** Plain-text answer used verbatim in FAQPage JSON-LD. */
  readonly answer: string;
  /** Rendered HTML answer on the landing page, matching `answer` with internal links. */
  readonly html: string;
}

/** Frequently asked questions rendered on the landing page and emitted as FAQPage JSON-LD. */
export const faqItems: readonly FaqItem[] = [
  {
    question: "Is Rondyr free and open source?",
    answer:
      "Yes. Rondyr is licensed under AGPL-3.0, and the EmDash plugin is MIT-licensed. You pay Cloudflare directly for Workers Paid ($5/month per account) and your email provider if you send emails, with no per-form or per-submission SaaS markup.",
    html: 'Yes. Rondyr is licensed under <a href="/contributing/">AGPL-3.0</a>, and the <a href="/emdash/">EmDash plugin</a> is MIT-licensed. You pay Cloudflare directly for Workers Paid ($5/month per account) and your email provider if you send emails, with no per-form or per-submission SaaS markup. See <a href="/costs/">Costs and limits</a> for the full breakdown.',
  },
  {
    question: "What spam classifier models does Rondyr use?",
    answer:
      "Rondyr uses Jev on Cloudflare Workers AI by default (no extra API keys required) and also supports the OpenAI Decisions API through Cloudflare AI Gateway unified billing. You can configure the second model as a tiebreaker for uncertain messages, alongside honeypot fields, Cloudflare Turnstile, rate limits, and repeat detection.",
    html: 'Rondyr uses <strong>Jev</strong> on Cloudflare Workers AI by default (no extra API keys required) and also supports the <strong>OpenAI Decisions</strong> API through Cloudflare AI Gateway unified billing. You can configure the second model as a tiebreaker for uncertain messages, alongside honeypot fields, Cloudflare Turnstile, rate limits, and repeat detection. See <a href="/spam-protection/">Fight spam</a>.',
  },
  {
    question: "Why self-host Rondyr instead of a hosted form service like Formspree or Basin?",
    answer:
      "Every submission stays in your own Cloudflare account, never on a third-party form SaaS server. You avoid per-form or per-submission pricing tiers, get classifier-model spam and sales-pitch screening tuned to your business description, and review doubtful messages in quarantine instead of losing real leads to silent spam drops. The trade-off is running your own Cloudflare Workers Paid account.",
    html: 'Every submission stays in your own Cloudflare account, never on a third-party form SaaS server. You avoid per-form or per-submission pricing tiers, get classifier-model spam and sales-pitch screening tuned to your business description, and review doubtful messages in quarantine instead of losing real leads to silent spam drops. The trade-off is running your own Cloudflare Workers Paid account; see <a href="/costs/">Costs and limits</a>.',
  },
  {
    question: "Does Rondyr work with static sites and frameworks like Astro, Next.js, or Hugo?",
    answer:
      "Yes. Any page that can render an HTML form or call fetch with JSON works with Rondyr, including plain HTML, Astro, Next.js, Hugo, Eleventy, Jekyll, and SvelteKit. You can also forward submissions from your own server with API tokens and idempotency keys, or connect an EmDash site with the official plugin.",
    html: 'Yes. Any page that can render an HTML <code>&lt;form&gt;</code> or call <code>fetch</code> with JSON works with Rondyr, including plain HTML, Astro, Next.js, Hugo, Eleventy, Jekyll, and SvelteKit. You can also forward submissions from your own server with <a href="/api/#server-intake">API tokens and idempotency keys</a>, or connect an EmDash site with the <a href="/emdash/">EmDash plugin</a>.',
  },
  {
    question: "How do I deploy and update a self-hosted Rondyr instance?",
    answer:
      "Select Deploy to Cloudflare to copy the repository to your GitHub or GitLab account and deploy in a few minutes without a terminal. Updates arrive through the included Update Rondyr GitHub Actions workflow, or you can deploy from a fork with Alchemy and GitHub Actions on a custom domain.",
    html: 'Select <strong>Deploy to Cloudflare</strong> to copy the repository to your GitHub or GitLab account and deploy in a few minutes without a terminal. Updates arrive through the included Update Rondyr GitHub Actions workflow, or you can deploy from a fork with <a href="/deployment/#deploy-with-alchemy-and-github-actions">Alchemy and GitHub Actions</a> on a custom domain. See <a href="/deployment/">Deploy Rondyr</a>.',
  },
  {
    question: "Where are form submissions stored, and how are they forwarded?",
    answer:
      "Submissions are stored in your Cloudflare account with configurable automatic retention and CSV or JSON Lines exports. Accepted messages go out automatically through Resend or Cloudflare Email Sending, HMAC-SHA-256 signed webhooks, or built-in Discord, Slack, and Airtable connectors.",
    html: 'Submissions are stored in your Cloudflare account with configurable <a href="/inbox/#automatic-retention">automatic retention</a> and CSV or JSON Lines exports. Accepted messages go out automatically through <a href="/email/">Resend or Cloudflare Email Sending</a>, <a href="/webhooks/">HMAC-SHA-256 signed webhooks</a>, or built-in <a href="/connectors/">Discord, Slack, and Airtable connectors</a>.',
  },
];

export interface ComparisonRow {
  readonly aspect: string;
  readonly rondyr: string;
  readonly hosted: string;
}

/** Side-by-side comparison between self-hosted Rondyr and hosted form backend SaaS services. */
export const comparisonRows: readonly ComparisonRow[] = [
  {
    aspect: "Hosting and data ownership",
    rondyr: "Runs in your own Cloudflare account; submissions stay under your control.",
    hosted: "Stored on a third-party vendor's servers.",
  },
  {
    aspect: "Deployment",
    rondyr: "One-click Deploy to Cloudflare button, or Alchemy with GitHub Actions.",
    hosted: "SaaS account signup and vendor dashboard.",
  },
  {
    aspect: "Pricing and limits",
    rondyr:
      "Open-source (AGPL-3.0). Pay Cloudflare Workers Paid ($5/month per account) with no per-form or per-submission SaaS markup.",
    hosted: "Monthly tiers billed per form, per seat, or per submission cap.",
  },
  {
    aspect: "Spam and sales-pitch filtering",
    rondyr:
      "Classifier models (Jev on Workers AI or OpenAI Decisions) score spam, unsolicited sales pitches, and business relevance, layered with honeypot and Turnstile.",
    hosted: "CAPTCHA widgets or generic keyword and IP blocklists.",
  },
  {
    aspect: "Uncertain messages",
    rondyr:
      "Held in To review quarantine with a plain reason until a person accepts or archives them; real leads are never silently dropped.",
    hosted: "Often blocked at intake or dropped into a hidden spam folder.",
  },
  {
    aspect: "Forwarding and integrations",
    rondyr:
      "Resend, Cloudflare Email Sending, HMAC-SHA-256 webhooks, Discord, Slack, Airtable, EmDash plugin, and HTTP API.",
    hosted: "Webhooks and integrations often gated behind higher paid plans.",
  },
];

/** Honest scope note shown below the comparison table and in llms.txt. */
export const comparisonTradeoff =
  "Choose a hosted SaaS form builder instead if you need drag-and-drop multi-step surveys, file attachments, or zero Cloudflare account setup.";

/** The prompt on the landing page for a coding agent to deploy and wire Rondyr. */
export const agentPrompt = `Deploy Rondyr for me and connect my site's form to it.

1. Read https://rondyr.com/deployment/ and ask whether I want the Deploy to Cloudflare button (fastest) or Alchemy with GitHub Actions.
2. Guide me through deploying on my Cloudflare Workers Paid account, generating a 32+ character \`RONDYR_SETUP_TOKEN\`, and creating my owner account, organization, and first form.
3. Ask how I want accepted messages forwarded (Resend email, Cloudflare Email Sending, webhook, or the EmDash plugin) and follow the matching guide on https://rondyr.com/.
4. Wire the form URL into my site (plain HTML, JSON fetch, or EmDash), add a honeypot field, and help me send a test message to verify it arrives.`;

/** The form of the landing page, as a site would write it. */
export const formSnippet = `<form action="https://rondyr.example.com/f/YOUR_PUBLIC_ID" method="post">
  <input type="email" name="email" required />
  <textarea name="message" required></textarea>
  <button type="submit">Send</button>
</form>`;
