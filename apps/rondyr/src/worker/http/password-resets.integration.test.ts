import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, beforeAll, it } from "@effect/vitest";
import { Clock, Effect, Schema } from "effect";

import { testOrigin as origin } from "../../../tests/integration/auth-fixture.ts";
import {
  invite,
  memberPassword,
  seedAccount,
  signInAs,
} from "../../../tests/integration/member-fixture.ts";
import {
  call,
  createInbox,
  json,
  signIn,
} from "../../../tests/integration/organization-fixture.ts";
import { emailsMatching, emailsTo } from "../../../tests/integration/recipient-fixture.ts";
import { InboxOrganizationWithForms } from "../../domain/submissions/inbox-setup.ts";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

const readInboxes = Schema.decodeUnknownEffect(Schema.Array(InboxOrganizationWithForms));
const newPassword = "a-new-password-for-the-owner";
const linkPattern = /^(https?:\/\/\S+)\/reset-password#([A-Za-z0-9_-]{43})$/mu;

/** The secret of the last reset link that `email` got, once `count` links arrived. */
const resetToken = Effect.fnUntraced(function* (email: string, count = 1) {
  const resets = yield* emailsMatching(email, /\/reset-password#[A-Za-z0-9_-]{43}/u, count);
  const match = linkPattern.exec(resets.at(-1)?.text ?? "");
  if (match === null) return assert.fail(`Expected a reset link for ${email}`);
  assert.strictEqual(match[1], origin);
  return { token: match[2] ?? "", email: resets.at(-1) };
});

const requestReset = (email: string) => call("POST", "/api/password-resets", { email });

let clients = 0;

/** The status of a sign-in, from a client of its own so that no limit applies. */
const signInStatus = (email: string, password: string) =>
  Effect.suspend(() => {
    clients += 1;
    return call(
      "POST",
      "/api/auth/sign-in/email",
      { email, password },
      { "cf-connecting-ip": `198.51.100.${clients}` },
    );
  }).pipe(Effect.map(({ status }) => status));

it.live("emails a single-use link that sets a new password and signs every session out", () =>
  Effect.gen(function* () {
    // The first account of the installation comes from the setup, before any other.
    yield* signIn;
    const session = yield* seedAccount("reset-owner", "reset-owner@example.test");
    yield* createInbox("Reset owner", session);

    const unknown = yield* requestReset("nobody@example.test");
    // The address is compared without its case.
    const requested = yield* requestReset("Reset-Owner@Example.test");
    const { token, email } = yield* resetToken("reset-owner@example.test");
    const stored = yield* Effect.promise(() =>
      env.DB.prepare("SELECT token_hash FROM password_resets WHERE user_id = 'reset-owner'").first(
        "token_hash",
      ),
    );
    const digest = yield* Effect.promise(() =>
      crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    );
    const tooShort = yield* call("POST", "/api/password-resets/complete", {
      token,
      password: "short",
    });
    const completed = yield* call("POST", "/api/password-resets/complete", {
      token,
      password: newPassword,
    });
    const reused = yield* call("POST", "/api/password-resets/complete", {
      token,
      password: "yet-another-password-here",
    });
    const oldSession = yield* call("GET", "/api/organizations", undefined, session);
    const oldPassword = yield* signInStatus("reset-owner@example.test", memberPassword);
    const verified = yield* Effect.promise(() =>
      env.DB.prepare("SELECT email_verified FROM auth_users WHERE id = 'reset-owner'").first(
        "email_verified",
      ),
    );
    const unknownEmails = yield* emailsTo("nobody@example.test");

    assert.deepEqual([unknown.status, requested.status], [202, 202]);
    assert.deepEqual([unknown.headers.get("cache-control")], ["no-store"]);
    assert.lengthOf(unknownEmails, 0);
    assert.strictEqual(
      stored,
      [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
    assert.notInclude(email?.text, "Reset owner");
    assert.strictEqual(tooShort.status, 400);
    assert.strictEqual(completed.status, 204);
    assert.strictEqual(reused.status, 404);
    const reusedBody = yield* json(reused);
    assert.deepEqual(reusedBody, { error: "reset-invalid" });
    assert.strictEqual(oldSession.status, 401);
    assert.strictEqual(oldPassword, 401);
    assert.strictEqual(verified, 1);
    yield* signInAs("reset-owner@example.test", newPassword);
  }),
);

it.live("refuses an expired link, and sends at most 3 links a day to an account", () =>
  Effect.gen(function* () {
    yield* seedAccount("reset-limits", "reset-limits@example.test");
    const first = yield* requestReset("reset-limits@example.test");
    assert.strictEqual(first.status, 202);
    const { token } = yield* resetToken("reset-limits@example.test");
    const now = yield* Clock.currentTimeMillis;
    yield* Effect.promise(() =>
      env.DB.prepare("UPDATE password_resets SET expires_at = ? WHERE user_id = 'reset-limits'")
        .bind(now - 1)
        .run(),
    );

    const expired = yield* call("POST", "/api/password-resets/complete", {
      token,
      password: newPassword,
    });
    const more = yield* Effect.forEach([1, 2, 3], () =>
      requestReset("reset-limits@example.test").pipe(Effect.map(({ status }) => status)),
    );
    yield* resetToken("reset-limits@example.test", 3);
    const issued = yield* Effect.promise(() =>
      env.DB.prepare(
        "SELECT count(*) AS total FROM password_resets WHERE user_id = 'reset-limits'",
      ).first("total"),
    );

    assert.strictEqual(expired.status, 404);
    assert.deepEqual(more, [202, 202, 202]);
    assert.strictEqual(issued, 3);
    const password = yield* signInStatus("reset-limits@example.test", memberPassword);
    assert.strictEqual(password, 200);
  }),
);

it.live(
  "lets the owner of an address take back an account that an admin created from a copied invitation",
  () =>
    Effect.gen(function* () {
      const admin = yield* signIn;
      const { id } = yield* createInbox("Copied invitation", admin);
      // The admin copies the link and creates the account without the mailbox.
      const { token: invitation } = yield* invite(id, admin, "claimed@example.test", "reviewer");
      const created = yield* call("POST", "/api/invitations/accept", {
        token: invitation,
        name: "Not the owner",
        password: "the-admin-chose-this-password",
      });
      assert.strictEqual(created.status, 201);
      const impostor = yield* signInAs("claimed@example.test", "the-admin-chose-this-password");

      // The owner of the mailbox resets the password.
      const requested = yield* requestReset("claimed@example.test");
      assert.strictEqual(requested.status, 202);
      const { token } = yield* resetToken("claimed@example.test");
      const completed = yield* call("POST", "/api/password-resets/complete", {
        token,
        password: newPassword,
      });
      const impostorAfter = yield* call("GET", "/api/organizations", undefined, impostor);
      const impostorPassword = yield* signInStatus(
        "claimed@example.test",
        "the-admin-chose-this-password",
      );
      const owner = yield* signInAs("claimed@example.test", newPassword);
      const inboxes = yield* call("GET", "/api/organizations", undefined, owner).pipe(
        Effect.flatMap(json),
        Effect.flatMap(readInboxes),
      );

      assert.strictEqual(completed.status, 204);
      assert.strictEqual(impostorAfter.status, 401);
      assert.strictEqual(impostorPassword, 401);
      assert.deepEqual(
        inboxes.map(({ id: organization, role }) => [organization, role]),
        [[id, "reviewer"]],
      );
    }),
);

it.live("refuses a request from another site", () =>
  Effect.gen(function* () {
    yield* seedAccount("reset-cross-site", "reset-cross-site@example.test");

    const response = yield* Effect.promise(() =>
      env.TEST_WORKER.fetch(new URL("/api/password-resets", origin), {
        method: "POST",
        headers: { origin: "https://attacker.example", "content-type": "application/json" },
        body: '{"email":"reset-cross-site@example.test"}',
      }),
    );
    const issued = yield* Effect.promise(() =>
      env.DB.prepare(
        "SELECT count(*) AS total FROM password_resets WHERE user_id = 'reset-cross-site'",
      ).first("total"),
    );

    assert.strictEqual(response.status, 403);
    assert.strictEqual(issued, 0);
  }),
);
