import { env } from "cloudflare:workers";
import { assert } from "@effect/vitest";
import { Clock, Effect, Redacted, Schema } from "effect";

import { PasskeyCreationOptions } from "../../src/domain/organizations/authentication.ts";
import { IssuedInvitation } from "../../src/domain/organizations/members.ts";
import { testOrigin as origin, testRecoveryToken } from "./auth-fixture.ts";
import { call, cookieOf, json, signInWithPasskey } from "./organization-fixture.ts";
import { registerVirtualPasskey, type VirtualPasskey } from "./webauthn-helper.mjs";

const readIssued = Schema.decodeUnknownEffect(IssuedInvitation);
const readCreationOptions = Schema.decodeUnknownEffect(PasskeyCreationOptions);

export { cookieOf };

let clients = 0;

/** Sign in with a virtual passkey, using a distinct client IP per call so rate limits stay clear. */
export const signInWithKey = Effect.fnUntraced(function* (passkey: VirtualPasskey) {
  clients += 1;
  return yield* signInWithPasskey(passkey, { clientIp: `192.0.2.${clients}` });
});

/** An account created directly in D1, outside any organization, and signed in via recovery passkey. */
export const seedAccount = Effect.fnUntraced(function* (id: string, email: string) {
  const now = yield* Clock.currentTimeMillis;
  yield* Effect.promise(() =>
    env.DB.prepare(
      "INSERT INTO auth_users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)",
    )
      .bind(id, id, email, now, now)
      .run(),
  );
  const authHeader = { authorization: `Bearer ${testRecoveryToken}` };
  const optionsResponse = yield* call("POST", "/api/auth/recovery/options", { email }, authHeader);
  assert.strictEqual(optionsResponse.status, 200);
  const creationOptions = yield* json(optionsResponse).pipe(Effect.flatMap(readCreationOptions));
  const { credential } = yield* Effect.promise(() =>
    registerVirtualPasskey(creationOptions, origin),
  );
  const verifyResponse = yield* call(
    "POST",
    "/api/auth/recovery/verify",
    { credential },
    authHeader,
  );
  assert.strictEqual(verifyResponse.status, 201);
  return { cookie: cookieOf(verifyResponse) };
});

/** Invite an address, and return the invitation with the secret of its link. */
export const invite = Effect.fnUntraced(function* (
  organizationId: string,
  headers: HeadersInit,
  email: string,
  role: "reviewer" | "admin",
) {
  const response = yield* call(
    "POST",
    `/api/organizations/${organizationId}/invitations`,
    { email, role },
    headers,
  );
  assert.strictEqual(response.status, 201);
  assert.strictEqual(response.headers.get("cache-control"), "no-store");
  const issued = yield* json(response).pipe(Effect.flatMap(readIssued));
  const link = new URL(Redacted.value(issued.link));
  assert.strictEqual(link.origin, origin);
  assert.strictEqual(link.pathname, "/invitation");
  return { ...issued, token: link.hash.slice(1) };
});

/** Invite an address and accept atomically with a new passkey account, returning session and passkey. */
export const addMemberWithPasskey = Effect.fnUntraced(function* (
  organizationId: string,
  headers: HeadersInit,
  email: string,
  role: "reviewer" | "admin",
) {
  const { token } = yield* invite(organizationId, headers, email, role);
  const optionsResponse = yield* call("POST", "/api/invitations/options", {
    token,
    name: email.split("@", 1)[0] ?? email,
  });
  assert.strictEqual(optionsResponse.status, 200);
  const creationOptions = yield* json(optionsResponse).pipe(Effect.flatMap(readCreationOptions));
  const { passkey, credential } = yield* Effect.promise(() =>
    registerVirtualPasskey(creationOptions, origin),
  );
  const accepted = yield* call("POST", "/api/invitations/verify", { token, credential });
  assert.strictEqual(accepted.status, 201);
  return { headers: { cookie: cookieOf(accepted) }, passkey };
});

/** Invite an address and accept atomically with a new passkey account, returning the session cookie header. */
export const addMember = Effect.fnUntraced(function* (
  organizationId: string,
  headers: HeadersInit,
  email: string,
  role: "reviewer" | "admin",
) {
  const { headers: session } = yield* addMemberWithPasskey(organizationId, headers, email, role);
  return session;
});
