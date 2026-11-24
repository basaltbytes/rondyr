# Security

## Reporting a vulnerability

Report it privately through GitHub: open [a new security advisory](https://github.com/basaltbytes/rondyr/security/advisories/new) on this repository, or click **Report a vulnerability** under the **Security** tab. Only the maintainers see the report. Please don't open a public issue or pull request for it.

Include what an attacker controls, what they get, and the smallest request or form that shows it. A `curl` command against a local instance (`pnpm dev`, see [docs/local-development.md](docs/local-development.md)) is worth more than a description. Never send real submissions or personal data with a report.

## What to expect

We reply in the advisory to confirm that we received the report and to say whether we consider it a vulnerability. The discussion, the fix and its review stay in the advisory's private thread. Once the fix is on `main`, we publish the advisory, request a CVE through GitHub when it applies, and credit you unless you ask us not to.

## Scope

Rondyr receives messages from the public internet and runs in the operator's Cloudflare account. These parts are in scope:

- the public form URL, `/f/<public-id>`: body parsing, the honeypot field, Turnstile, allowed origins, rate limits and daily quotas ([docs/forms.md](docs/forms.md));
- sign-in, sessions, the first-account setup, invitations, password resets, and the roles and isolation between organizations;
- the dashboard and its API, including API tokens and server intake ([docs/api.md](docs/api.md));
- webhook delivery: the signature, the URL rules that refuse private and local addresses, and the encryption of secrets in D1 ([docs/webhooks.md](docs/webhooks.md));
- email delivery and recipient confirmation ([docs/email.md](docs/email.md));
- anything that writes message content to the logs, to the event history, or to an error summary;
- the EmDash plugin in `packages/emdash-plugin/` ([docs/emdash.md](docs/emdash.md));
- the deployment configuration and the GitHub workflows of this repository.

Out of scope:

- a spam message that the classifier accepts, or a real message that it quarantines. Quarantine is the safety net for a wrong score; report a wrong score as an ordinary issue. A way to make the classifier skip the review of messages it should quarantine is in scope.
- limits that the documentation already describes as approximate, such as the per-client rate limit, which Cloudflare counts per location;
- Cloudflare, Resend, GitHub and the other services Rondyr runs on. Report their vulnerabilities to them;
- attacks that need control of the operator's Cloudflare account or of a Worker secret.

## Supported versions

Rondyr is pre-alpha and has no releases yet. Fixes land on `main`, and an instance gets them when its operator updates it ([Updates](docs/deployment.md#updates)).
