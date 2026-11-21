import { env } from "cloudflare:workers";
import { assert } from "@effect/vitest";
import { hashPassword } from "better-auth/crypto";
import { Clock, Effect, Redacted, Schema } from "effect";

import { IssuedInvitation } from "../../src/domain/organizations/members.ts";
import { testOrigin as origin } from "./auth-fixture.ts";
import { call, json } from "./organization-fixture.ts";

const readIssued = Schema.decodeUnknownEffect(IssuedInvitation);

/** The password of every account that these helpers create. */
export const memberPassword = "invited-member-test-password";

/** The cookies of a response, as a request sends them back. */
export const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");

let clients = 0;

/** Better Auth limits sign-in attempts per address: each sign-in here comes from its own client. */
export const signInAs = Effect.fnUntraced(function* (email: string, secret = memberPassword) {
  clients += 1;
  const response = yield* call(
    "POST",
    "/api/auth/sign-in/email",
    { email, password: secret },
    { "cf-connecting-ip": `192.0.2.${clients}` },
  );
  assert.strictEqual(response.status, 200);
  return { cookie: cookieOf(response) };
});

/** An account created directly in D1, outside any organization, and signed in. */
export const seedAccount = Effect.fnUntraced(function* (id: string, email: string) {
  const hash = yield* Effect.promise(() => hashPassword(memberPassword));
  const now = yield* Clock.currentTimeMillis;
  yield* Effect.promise(() =>
    env.DB.batch([
      env.DB.prepare(
        "INSERT INTO auth_users (id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(id, id, email, now, now),
      env.DB.prepare(`
        INSERT INTO auth_accounts (id, user_id, account_id, provider_id, password, created_at, updated_at)
        VALUES (?, ?, ?, 'credential', ?, ?, ?)
      `).bind(id, id, id, hash, now, now),
    ]),
  );
  return yield* signInAs(email);
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

/** Invite an address and accept with a new account, then sign in with it. */
export const addMember = Effect.fnUntraced(function* (
  organizationId: string,
  headers: HeadersInit,
  email: string,
  role: "reviewer" | "admin",
) {
  const { token } = yield* invite(organizationId, headers, email, role);
  const accepted = yield* call("POST", "/api/invitations/accept", {
    token,
    name: email.split("@", 1)[0] ?? email,
    password: memberPassword,
  });
  assert.strictEqual(accepted.status, 201);
  return yield* signInAs(email);
});
