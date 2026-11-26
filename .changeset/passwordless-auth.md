---
"rondyr": minor
---

Replace password authentication and `better-auth` with passwordless Passkeys (`@oslojs/webauthn` + Web Crypto), conditional Email OTP sign-in, `RONDYR_RECOVERY_TOKEN` recovery and custom-domain migration, and an Account Security passkey manager, enabling one-click test-drives on Cloudflare Workers Free within the 10 ms CPU limit.

**Upgrading an existing instance:** this release deletes the stored passwords, and everyone signs in again. With an email provider configured, sign in with an email code and add a passkey in **Account → Security**. Without one, set the `RONDYR_RECOVERY_TOKEN` secret (at least 32 characters), use **Recover access** on `/sign-in` for each account, then delete the secret. See "Update from a version that signed in with passwords" in `docs/deployment.md`.
