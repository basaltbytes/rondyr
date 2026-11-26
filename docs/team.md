# Team and accounts

Public sign-up is closed on every Rondyr instance. Accounts sign in without passwords using **passkeys** (always enabled) and optional **Email OTP** sign-in codes. After creating the owner account, invite teammates from the dashboard and assign each person the **Reviewer** or **Admin** role.

![Settings Members screen showing Camille as Admin, the Invite someone form with email address and role selector, and pending invitations](./screenshots/members.webp)

## Invite someone

1. Open **Settings → Members** in the dashboard (only an admin can open this section).
2. Enter the person's email address, pick a role (**Reviewer** or **Admin**), and select **Invite**.
3. If your instance sends email (see [Send messages by email](./email.md)), Rondyr emails them an invitation link automatically. Either way, Rondyr shows the link once right after creation so you can copy it and send it yourself.

Each invitation link works once and expires after 7 days. An organization can have up to 20 pending invitations at a time, and an address receives at most 3 invitation emails in 24 hours across the instance; past that limit, copy the link from the dashboard and send it directly.

When the invited person opens the link:

- If they don't have an account on this Rondyr instance yet, they enter their name and register a passkey. Cancelling the browser prompt leaves no account behind; completing it creates the account, signs them in immediately, and adds them to the organization.
- If they already have an account at that address, they sign in with their passkey or an email code and join the organization.
- If they are signed in under a different email address, Rondyr asks them to sign out first.

Pending invitations stay listed under **Invite someone**, where an admin can cancel them at any time. Creating a new invitation for the same email address replaces the previous pending link.

## Roles

Each member has one role per organization. A single account can belong to several organizations with different roles in each, and an admin of any organization can create a new one (becoming its admin). On a new instance, the first account creates the first organization. An account that belongs to no organization, for example after its removal from the last one, cannot create one: the dashboard tells it to ask an admin for an invitation.

| Role | Permissions |
| --- | --- |
| **Reviewer** | Read messages, search the inbox, accept or archive quarantined messages, reclassify messages that failed analysis, and view delivery history |
| **Admin** | Everything a reviewer can do, plus manage forms, allowed origins, honeypot and Turnstile settings, destinations, delivery retries, test sends, classification rules, daily quotas, API tokens, members, exports, message deletion, retention, and the **Status** page |

## Change a role or remove a member

In **Settings → Members**, use the role dropdown next to a member to switch between **Admin** and **Reviewer**, or select **Remove** to revoke their access to the organization.

Keep these rules in mind before making changes:

- **Last admin protection.** Every organization keeps at least one admin; promote someone else before stepping down or removing the last admin.
- **Stepping down.** If you switch your own role from Admin to Reviewer, Rondyr asks you to confirm, because only another admin can promote you back.
- **API tokens and pending invitations.** Removing a member immediately revokes every API token they created in that organization and cancels any pending invitations they sent. Before you confirm, Rondyr tells you how many active tokens will stop working, so you can give affected websites or scripts a token created by another admin first. Demoting an admin to reviewer cancels their pending invitations, while their existing API tokens keep working.

Removing a member removes them from the organization only; their account still exists, and an admin can invite them again later. When it was their last organization, Rondyr also signs them out on every device.

## Passkeys and Email OTP

Every Rondyr instance enables passkey sign-in out of the box with no external configuration. On `/sign-in`, select **Sign in with a passkey** to authenticate with a discoverable passkey stored in your browser, OS keychain, or hardware security key. A passkey is the only factor, so Rondyr requires user verification: the device asks for its PIN, fingerprint or face, and a hardware security key needs a PIN.

When an email provider is configured (see [Send messages by email](./email.md)), **Or sign in with an email code** appears automatically on `/sign-in`:

- Entering an account's email address sends a single-use 6-digit code valid for 10 minutes.
- Each address can receive up to 5 codes per hour and 10 per day. Past a cap, the page shows the same confirmation and no email is sent.
- Asking for another code leaves the earlier ones valid until they expire, so a request made in your name cannot cancel the code you hold. Signing in spends every code of the address.
- 5 wrong guesses lock out every code the address holds at that moment; ask for a new one.
- Unknown email addresses never create an account and receive the same confirmation message for privacy.

When no email provider is configured, Email OTP stays hidden and its endpoints return `503`.

## Manage passkeys

Open the account menu at the foot of the sidebar and select **Security** to manage the passkeys registered on your account.

- Add backup passkeys (for example a second device or a hardware security key) with an optional label.
- Rename existing passkeys at any time.
- Delete passkeys you no longer use. When Email OTP is not configured, Rondyr refuses to delete your last passkey for the current domain so you don't lock yourself out; a passkey bound to another hostname does not count, because it cannot sign in here.
- Deleting a passkey signs your account out on every other device, so a session opened with that passkey ends with it.
- Passkeys bound to another hostname (such as an old `workers.dev` address after attaching a custom domain) are marked with their domain name so you can clean them up once your new passkey works.

## Recover access and migrate domains

WebAuthn passkeys are bound to a hostname (`rpID`), so a passkey created on `*.workers.dev` does not work after attaching a custom domain. You have two recovery paths:

- **With email configured:** open `/sign-in` on the new domain or device, sign in with an email code, then open **Account → Security** to register a new passkey.
- **Without email configured (or full lockout):** add a secret named `RONDYR_RECOVERY_TOKEN` (at least 32 characters, for example `openssl rand -hex 32`) in Cloudflare under **Workers & Pages → rondyr → Settings → Variables and Secrets**. Reload `/sign-in`, select **Recover access**, enter the recovery token and an existing account's email address, and register a new passkey for the current domain. You are signed in immediately, and every earlier session of that account ends. Delete `RONDYR_RECOVERY_TOKEN` from Cloudflare afterward.

## Rotate instance secrets

To replace a secret on an instance deployed with the button, open **Workers & Pages → rondyr → Settings → Variables and Secrets** in the Cloudflare dashboard, update the value, and save. On an Alchemy deployment, update the matching `*_PROD` secret in your GitHub fork and run the **Deploy** workflow.

- **`RONDYR_SESSION_SECRET`** (legacy name `BETTER_AUTH_SECRET`): set a new random string of at least 32 characters (`openssl rand -hex 32`). Everyone will be signed out and will need to sign in again.
- **`RESEND_API_KEY`**: create a new sending key in Resend, replace the secret, send a test email from **Destinations** to confirm it works, then revoke the old key in Resend.
- **`RONDYR_SECRETS_KEY`**: set a new 32-byte base64 key (`openssl rand -base64 32`). Afterward, rotate each webhook's signing secret in **Destinations** (and update the receiving apps) and re-save the Turnstile keys on any form that uses Turnstile.
