import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, beforeAll, it, vi } from "@effect/vitest";
import { hashPassword } from "better-auth/crypto";
import { Clock, Effect, Redacted, Schema } from "effect";

import { testOrigin as origin } from "../../tests/integration/auth-fixture.ts";
import { call, createInbox, json, signIn } from "../../tests/integration/organization-fixture.ts";
import {
  InvitationSummary,
  IssuedInvitation,
  Member,
  OrganizationMembers,
} from "../domain/organizations/members.ts";
import { InboxOrganizationWithForms } from "../domain/submissions/inbox-setup.ts";
import { SubmissionId } from "../domain/submissions/submission.id.ts";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

const readIssued = Schema.decodeUnknownEffect(IssuedInvitation);
const readMembers = Schema.decodeUnknownEffect(OrganizationMembers);
const readMember = Schema.decodeUnknownEffect(Member);
const readSummary = Schema.decodeUnknownEffect(InvitationSummary);
const readInboxes = Schema.decodeUnknownEffect(Schema.Array(InboxOrganizationWithForms));
const readAccepted = Schema.decodeUnknownEffect(Schema.Struct({ "submission-id": SubmissionId }));
const readError = Schema.decodeUnknownEffect(Schema.Struct({ error: Schema.String }));
const readEmails = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      body: Schema.fromJsonString(
        Schema.Struct({
          to: Schema.Array(Schema.String),
          subject: Schema.String,
          text: Schema.String,
        }),
      ),
    }),
  ),
);

const password = "invited-member-test-password";

const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");

let clients = 0;

/** Better Auth limits sign-in attempts per address: each sign-in here comes from its own client. */
const signInAs = Effect.fnUntraced(function* (email: string, secret = password) {
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
const seedAccount = Effect.fnUntraced(function* (id: string, email: string) {
  const hash = yield* Effect.promise(() => hashPassword(password));
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

const invite = Effect.fnUntraced(function* (
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
const addMember = Effect.fnUntraced(function* (
  organizationId: string,
  headers: HeadersInit,
  email: string,
  role: "reviewer" | "admin",
) {
  const { token } = yield* invite(organizationId, headers, email, role);
  const accepted = yield* call("POST", "/api/invitations/accept", {
    token,
    name: email.split("@", 1)[0] ?? email,
    password,
  });
  assert.strictEqual(accepted.status, 201);
  return yield* signInAs(email);
});

const quarantine = Effect.fnUntraced(function* (publicId: string) {
  const response = yield* Effect.promise(() =>
    env.TEST_WORKER.fetch(new URL(`/f/${publicId}`, origin), {
      method: "POST",
      body: new URLSearchParams({ email: "visitor@example.test", message: "Hello", _hp: "filled" }),
    }),
  );
  assert.strictEqual(response.status, 202);
  const { "submission-id": id } = yield* json(response).pipe(Effect.flatMap(readAccepted));
  yield* Effect.promise(() =>
    vi.waitFor(
      () =>
        env.DB.prepare("SELECT status FROM submission_inbox WHERE submission_id = ?")
          .bind(id)
          .first("status")
          .then((status) => assert.strictEqual(status, "quarantined")),
      { timeout: 15_000, interval: 100 },
    ),
  );
  return id;
});

/** Every route that only an admin of the organization may call, with a body it accepts. */
function administrationRoutes(organizationId: string, publicId: string) {
  const org = `/api/organizations/${organizationId}`;
  const form = `${org}/forms/${publicId}`;
  const target = `${org}/targets/example-target`;
  const submission = `${org}/submissions/73123ee4-40bf-4c5f-b8ff-1d56cdaa7640`;
  const invitation = "73123ee4-40bf-4c5f-b8ff-1d56cdaa7641";
  return [
    ["GET", `${org}/api-tokens`],
    ["POST", `${org}/api-tokens`, { name: "Site" }],
    ["DELETE", `${org}/api-tokens?id=example-token`],
    ["GET", `${org}/domains`],
    ["POST", `${org}/domains`, { domain: "example.com" }],
    ["DELETE", `${org}/domains?domain=example.com`],
    ["GET", `${org}/classification-policy`],
    ["PUT", `${org}/classification-policy`, { offTopic: "accept" }],
    ["DELETE", `${org}/classification-policy`],
    ["GET", `${org}/quotas`],
    ["PUT", `${org}/quotas`, { submissions: 10, classifications: 10 }],
    ["POST", `${org}/forms`, { name: "Other" }],
    ["PATCH", form, { name: "Renamed" }],
    ["POST", `${form}/suspend`],
    ["POST", `${form}/reactivate`],
    ["PUT", `${form}/success-url`, { url: "https://example.com/thanks" }],
    ["DELETE", `${form}/success-url`],
    ["PUT", `${form}/honeypot`, { field: "_hp" }],
    ["DELETE", `${form}/honeypot`],
    ["GET", `${form}/turnstile`],
    ["PUT", `${form}/turnstile`, { siteKey: "site", secretKey: "secret" }],
    ["DELETE", `${form}/turnstile`],
    ["GET", `${form}/origins`],
    ["POST", `${form}/origins`, { origin: "https://example.com" }],
    ["DELETE", `${form}/origins?origin=https%3A%2F%2Fexample.com`],
    ["GET", `${form}/targets`],
    ["POST", `${form}/targets`, { type: "webhook", url: "https://example.com/hook" }],
    ["POST", `${target}/rotate-secret`],
    ["PUT", `${target}/recipients`, { recipients: ["team@example.com"] }],
    ["POST", `${target}/activate`],
    ["POST", `${target}/deactivate`],
    ["POST", `${target}/test`],
    ["POST", `${target}/confirmations`, { address: "team@example.com" }],
    ["POST", `${submission}/deliveries/73123ee4-40bf-4c5f-b8ff-1d56cdaa7642/retry`],
    ["GET", `${org}/members`],
    ["PATCH", `${org}/members/example-user`, { role: "admin" }],
    ["DELETE", `${org}/members/example-user`],
    ["POST", `${org}/invitations`, { email: "someone@example.com", role: "reviewer" }],
    ["DELETE", `${org}/invitations?id=${invitation}`],
    ["GET", `${org}/submission-export?format=csv`],
    ["DELETE", submission],
    ["GET", `${org}/retention`],
    ["PUT", `${org}/retention`, { accepted: 30, quarantine: 30 }],
  ] as const;
}

const statusesOf = (routes: ReturnType<typeof administrationRoutes>, headers: HeadersInit) =>
  Effect.forEach(routes, ([method, path, body]) =>
    call(method, path, body, headers).pipe(Effect.map(({ status }) => [method, path, status])),
  );

it.live(
  "refuses every administration route to a reviewer with 403 and to another organization with 404",
  () =>
    Effect.gen(function* () {
      const admin = yield* signIn;
      const { id, forms } = yield* createInbox("Reviewed organization", admin);
      const form = forms[0];
      if (form === undefined) return assert.fail("Expected the contact form");
      const reviewer = yield* addMember(id, admin, "reviewer@example.test", "reviewer");
      const outsider = yield* seedAccount("outsider", "outsider@example.test");
      yield* createInbox("Outsider organization", outsider);
      const routes = administrationRoutes(id, form.publicId);

      const asReviewer = yield* statusesOf(routes, reviewer);
      const asOutsider = yield* statusesOf(routes, outsider);

      assert.deepEqual(
        asReviewer,
        routes.map(([method, path]) => [method, path, 403]),
      );
      assert.deepEqual(
        asOutsider,
        routes.map(([method, path]) => [method, path, 404]),
      );
      const unchanged = yield* call("GET", "/api/organizations", undefined, admin).pipe(
        Effect.flatMap(json),
        Effect.flatMap(readInboxes),
      );
      assert.deepEqual(
        unchanged.find((inbox) => inbox.id === id)?.forms.map(({ name, status }) => [name, status]),
        [["Contact", "active"]],
      );
    }),
  60_000,
);

it.live("lets a reviewer read the inbox and the deliveries, accept and archive", () =>
  Effect.gen(function* () {
    const admin = yield* signIn;
    const { id, forms } = yield* createInbox("Reviewer rights", admin);
    const form = forms[0];
    if (form === undefined) return assert.fail("Expected the contact form");
    const honeypot = yield* call(
      "PUT",
      `/api/organizations/${id}/forms/${form.publicId}/honeypot`,
      { field: "_hp" },
      admin,
    );
    assert.strictEqual(honeypot.status, 200);
    const reviewer = yield* addMember(id, admin, "rights-reviewer@example.test", "reviewer");
    const first = yield* quarantine(form.publicId);
    const second = yield* quarantine(form.publicId);
    const submissions = `/api/organizations/${id}/submissions`;

    const inboxes = yield* call("GET", "/api/organizations", undefined, reviewer).pipe(
      Effect.flatMap(json),
      Effect.flatMap(readInboxes),
    );
    const listed = yield* call("GET", `${submissions}?status=quarantined`, undefined, reviewer);
    const counts = yield* call(
      "GET",
      `/api/organizations/${id}/submission-counts`,
      undefined,
      reviewer,
    );
    const approved = yield* call("POST", `${submissions}/${first}/approve`, undefined, reviewer);
    const dismissed = yield* call("POST", `${submissions}/${second}/dismiss`, undefined, reviewer);
    const history = yield* call("GET", `${submissions}/${first}/deliveries`, undefined, reviewer);
    const operations = yield* call("GET", "/api/operations", undefined, reviewer).pipe(
      Effect.flatMap(json),
    );

    assert.deepEqual(
      inboxes.map(({ id: organization, role }) => [organization, role]),
      [[id, "reviewer"]],
    );
    assert.deepEqual(
      [listed.status, counts.status, approved.status, dismissed.status, history.status],
      [200, 200, 200, 200, 200],
    );
    assert.deepEqual(operations, { organizations: [], lastSuccessfulCronAt: null });
  }),
);

it.live("invites by email, lists the invitation, and stores only the hash of its link", () =>
  Effect.gen(function* () {
    const admin = yield* signIn;
    const { id } = yield* createInbox("Invitation listing", admin);

    const issued = yield* invite(id, admin, "Listed@Example.test", "admin");
    const listed = yield* call("GET", `/api/organizations/${id}/members`, undefined, admin).pipe(
      Effect.flatMap(json),
      Effect.flatMap(readMembers),
    );
    const stored = yield* Effect.promise(() =>
      env.DB.prepare("SELECT token_hash FROM organization_invitations WHERE id = ?")
        .bind(issued.invitation.id)
        .first("token_hash"),
    );
    const digest = yield* Effect.promise(() =>
      crypto.subtle.digest("SHA-256", new TextEncoder().encode(issued.token)),
    );
    const emails = yield* Effect.promise(() =>
      env.RESEND_FIXTURE.fetch("https://resend.test/__received?recipient=listed@example.test"),
    ).pipe(Effect.flatMap(json), Effect.flatMap(readEmails));

    assert.strictEqual(issued.email, "sent");
    assert.strictEqual(issued.invitation.email, "listed@example.test");
    assert.strictEqual(issued.invitation.expiresAt - issued.invitation.createdAt, 7 * 86_400_000);
    assert.deepEqual(listed.invitations, [issued.invitation]);
    assert.deepEqual(
      listed.members.map(({ email, role }) => [email, role]),
      [["settings-admin@example.test", "admin"]],
    );
    assert.strictEqual(
      stored,
      [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
    assert.lengthOf(emails, 1);
    assert.include(emails[0]?.body.text, Redacted.value(issued.link));
    assert.notInclude(emails[0]?.body.text, "Invitation listing");
  }),
);

it.live("refuses an expired, a reused and a cancelled invitation", () =>
  Effect.gen(function* () {
    const admin = yield* signIn;
    const { id } = yield* createInbox("Invitation lifecycle", admin);
    const expired = yield* invite(id, admin, "expired@example.test", "reviewer");
    const reused = yield* invite(id, admin, "reused@example.test", "reviewer");
    const cancelled = yield* invite(id, admin, "cancelled@example.test", "reviewer");
    const now = yield* Clock.currentTimeMillis;
    yield* Effect.promise(() =>
      env.DB.prepare("UPDATE organization_invitations SET expires_at = ? WHERE id = ?")
        .bind(now - 1, expired.invitation.id)
        .run(),
    );
    const first = yield* call("POST", "/api/invitations/accept", {
      token: reused.token,
      name: "Reused",
      password,
    });
    assert.strictEqual(first.status, 201);
    const removed = yield* call(
      "DELETE",
      `/api/organizations/${id}/invitations?id=${cancelled.invitation.id}`,
      undefined,
      admin,
    );
    assert.strictEqual(removed.status, 204);

    const attempts = yield* Effect.forEach([expired, reused, cancelled], ({ token }) =>
      Effect.all([
        call("POST", "/api/invitations/read", { token }),
        call("POST", "/api/invitations/accept", { token, name: "Late", password }),
      ]),
    );
    const bodies = yield* Effect.forEach(attempts.flat(), (response) =>
      json(response).pipe(Effect.flatMap(readError)),
    );
    const again = yield* call(
      "DELETE",
      `/api/organizations/${id}/invitations?id=${cancelled.invitation.id}`,
      undefined,
      admin,
    );

    assert.deepEqual(
      attempts.flat().map(({ status }) => status),
      [404, 404, 404, 404, 404, 404],
    );
    assert.deepEqual(
      bodies.map(({ error }) => error),
      Array.from({ length: 6 }, () => "invitation-invalid"),
    );
    assert.strictEqual(again.status, 404);
    const accounts = yield* Effect.promise(() =>
      env.DB.prepare("SELECT count(*) AS total FROM auth_users WHERE email IN (?, ?)")
        .bind("expired@example.test", "cancelled@example.test")
        .first("total"),
    );
    assert.strictEqual(accounts, 0);
  }),
);

it.live("creates an account at the invited address, which then signs in", () =>
  Effect.gen(function* () {
    const admin = yield* signIn;
    const { id } = yield* createInbox("New account", admin);
    const { token } = yield* invite(id, admin, "newcomer@example.test", "reviewer");

    const summary = yield* call("POST", "/api/invitations/read", { token }).pipe(
      Effect.flatMap(json),
      Effect.flatMap(readSummary),
    );
    const missing = yield* call("POST", "/api/invitations/accept", { token });
    const short = yield* call("POST", "/api/invitations/accept", {
      token,
      name: "Newcomer",
      password: "too-short",
    });
    const accepted = yield* call("POST", "/api/invitations/accept", {
      token,
      name: "Newcomer",
      password,
    });
    const session = yield* signInAs("newcomer@example.test");
    const inboxes = yield* call("GET", "/api/organizations", undefined, session).pipe(
      Effect.flatMap(json),
      Effect.flatMap(readInboxes),
    );

    assert.deepEqual(summary, {
      organizationName: "New account",
      email: "newcomer@example.test",
      role: "reviewer",
      account: "new",
    });
    assert.strictEqual(missing.status, 400);
    const missingBody = yield* json(missing);
    assert.deepEqual(missingBody, { error: "account-required" });
    assert.strictEqual(short.status, 400);
    assert.strictEqual(accepted.status, 201);
    const acceptedBody = yield* json(accepted);
    assert.deepEqual(acceptedBody, { organizationId: id });
    assert.deepEqual(
      inboxes.map(({ id: organization, role }) => [organization, role]),
      [[id, "reviewer"]],
    );
  }),
);

it.live("lets an existing account at the invited address sign in, then join", () =>
  Effect.gen(function* () {
    const admin = yield* signIn;
    const { id } = yield* createInbox("Existing account", admin);
    const existing = yield* seedAccount("existing-account", "existing@example.test");
    const other = yield* seedAccount("other-account", "other@example.test");
    const { token } = yield* invite(id, admin, "existing@example.test", "admin");

    const summary = yield* call("POST", "/api/invitations/read", { token }).pipe(
      Effect.flatMap(json),
      Effect.flatMap(readSummary),
    );
    const anonymous = yield* call("POST", "/api/invitations/accept", {
      token,
      name: "Intruder",
      password,
    });
    const wrongAccount = yield* call("POST", "/api/invitations/accept", { token }, other);
    const accepted = yield* call("POST", "/api/invitations/accept", { token }, existing);
    const inboxes = yield* call("GET", "/api/organizations", undefined, existing).pipe(
      Effect.flatMap(json),
      Effect.flatMap(readInboxes),
    );

    assert.strictEqual(summary.account, "existing");
    assert.strictEqual(anonymous.status, 409);
    const anonymousBody = yield* json(anonymous);
    assert.deepEqual(anonymousBody, { error: "sign-in-required" });
    assert.strictEqual(wrongAccount.status, 403);
    const wrongAccountBody = yield* json(wrongAccount);
    assert.deepEqual(wrongAccountBody, { error: "other-account" });
    assert.strictEqual(accepted.status, 200);
    assert.deepEqual(
      inboxes.map(({ id: organization, role }) => [organization, role]),
      [[id, "admin"]],
    );
    const passwords = yield* Effect.promise(() =>
      env.DB.prepare(
        "SELECT count(*) AS total FROM auth_accounts a JOIN auth_users u ON u.id = a.user_id WHERE u.email = ?",
      )
        .bind("existing@example.test")
        .first("total"),
    );
    assert.strictEqual(passwords, 1);
  }),
);

it.live(
  "refuses an invitation to a member, and over the limit of pending invitations",
  () =>
    Effect.gen(function* () {
      const admin = yield* signIn;
      const { id } = yield* createInbox("Invitation refusals", admin);
      const path = `/api/organizations/${id}/invitations`;
      const member = yield* call(
        "POST",
        path,
        { email: "SETTINGS-ADMIN@example.test", role: "admin" },
        admin,
      );
      yield* Effect.forEach(
        Array.from({ length: 20 }, (_, index) => index),
        (index) => invite(id, admin, `pending-${index}@example.test`, "reviewer"),
      );
      const again = yield* invite(id, admin, "pending-0@example.test", "admin");
      const over = yield* call(
        "POST",
        path,
        { email: "one-more@example.test", role: "reviewer" },
        admin,
      );

      assert.strictEqual(member.status, 409);
      const memberBody = yield* json(member);
      assert.deepEqual(memberBody, { error: "already-member" });
      assert.strictEqual(again.invitation.role, "admin");
      assert.strictEqual(over.status, 409);
      const overBody = yield* json(over);
      assert.deepEqual(overBody, { error: "invitation-limit" });
      const pending = yield* call("GET", `/api/organizations/${id}/members`, undefined, admin).pipe(
        Effect.flatMap(json),
        Effect.flatMap(readMembers),
      );
      assert.lengthOf(pending.invitations, 20);
    }),
  30_000,
);

it.live("changes a role and removes a member, never the last admin", () =>
  Effect.gen(function* () {
    const admin = yield* signIn;
    const { id } = yield* createInbox("Last admin", admin);
    yield* addMember(id, admin, "second-reviewer@example.test", "reviewer");
    const members = `/api/organizations/${id}/members`;
    const listed = yield* call("GET", members, undefined, admin).pipe(
      Effect.flatMap(json),
      Effect.flatMap(readMembers),
    );
    const owner = listed.members.find(({ role }) => role === "admin");
    const reviewer = listed.members.find(({ role }) => role === "reviewer");
    if (owner === undefined || reviewer === undefined) return assert.fail("Expected two members");

    const demoted = yield* call("PATCH", `${members}/${owner.userId}`, { role: "reviewer" }, admin);
    const removedSelf = yield* call("DELETE", `${members}/${owner.userId}`, undefined, admin);
    const promoted = yield* call(
      "PATCH",
      `${members}/${reviewer.userId}`,
      { role: "admin" },
      admin,
    );
    const changed = yield* json(promoted).pipe(Effect.flatMap(readMember));
    const demotedNow = yield* call(
      "PATCH",
      `${members}/${owner.userId}`,
      { role: "reviewer" },
      admin,
    );
    const removedLast = yield* call("DELETE", `${members}/${reviewer.userId}`, undefined, admin);
    const unknown = yield* call("DELETE", `${members}/nobody`, undefined, admin);

    assert.strictEqual(demoted.status, 409);
    const demotedBody = yield* json(demoted);
    assert.deepEqual(demotedBody, { error: "last-admin" });
    assert.strictEqual(removedSelf.status, 409);
    assert.strictEqual(promoted.status, 200);
    assert.strictEqual(changed.role, "admin");
    assert.strictEqual(demotedNow.status, 200);
    // The former owner is a reviewer now, and may no longer manage members.
    assert.strictEqual(removedLast.status, 403);
    assert.strictEqual(unknown.status, 403);
  }),
);

it.live(
  "keeps one admin when two admins leave or demote at the same time",
  () =>
    Effect.gen(function* () {
      const admin = yield* signIn;
      const scenarios = ["leave", "step down", "demote each other"] as const;
      const outcomes = yield* Effect.forEach(scenarios, (scenario, index) =>
        Effect.gen(function* () {
          const { id } = yield* createInbox(`Concurrent admins ${index}`, admin);
          const second = yield* addMember(id, admin, `admin-${index}@example.test`, "admin");
          const members = `/api/organizations/${id}/members`;
          const listed = yield* call("GET", members, undefined, admin).pipe(
            Effect.flatMap(json),
            Effect.flatMap(readMembers),
          );
          const owner = listed.members.find(({ email }) => email === "settings-admin@example.test");
          const added = listed.members.find(({ email }) => email !== "settings-admin@example.test");
          if (owner === undefined || added === undefined) return assert.fail("Expected two admins");
          // Each pair is [actor, member]: every request is allowed when it starts.
          const requests =
            scenario === "leave"
              ? [
                  call("DELETE", `${members}/${owner.userId}`, undefined, admin),
                  call("DELETE", `${members}/${added.userId}`, undefined, second),
                ]
              : scenario === "step down"
                ? [
                    call("PATCH", `${members}/${owner.userId}`, { role: "reviewer" }, admin),
                    call("PATCH", `${members}/${added.userId}`, { role: "reviewer" }, second),
                  ]
                : [
                    call("PATCH", `${members}/${added.userId}`, { role: "reviewer" }, admin),
                    call("PATCH", `${members}/${owner.userId}`, { role: "reviewer" }, second),
                  ];
          const results = yield* Effect.all(requests, { concurrency: "unbounded" });
          const admins = yield* Effect.promise(() =>
            env.DB.prepare(
              "SELECT count(*) AS total FROM organization_members WHERE organization_id = ? AND role = 'admin'",
            )
              .bind(id)
              .first("total"),
          );
          return { scenario, statuses: results.map(({ status }) => status).toSorted(), admins };
        }),
      );

      assert.deepEqual(outcomes, [
        { scenario: "leave", statuses: [204, 409], admins: 1 },
        { scenario: "step down", statuses: [200, 409], admins: 1 },
        { scenario: "demote each other", statuses: [200, 409], admins: 1 },
      ]);
    }),
  30_000,
);

it.live(
  "revokes the tokens and invitations of a removed member, and the invitations of a demoted one",
  () =>
    Effect.gen(function* () {
      const admin = yield* signIn;
      const { id } = yield* createInbox("Departures", admin);
      const leaving = yield* addMember(id, admin, "leaving-admin@example.test", "admin");
      const demoted = yield* addMember(id, admin, "demoted-admin@example.test", "admin");
      const token = yield* call(
        "POST",
        `/api/organizations/${id}/api-tokens`,
        { name: "Leaving" },
        leaving,
      );
      assert.strictEqual(token.status, 201);
      const { token: secret } = yield* json(token).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ token: Schema.String }))),
      );
      const byLeaving = yield* invite(id, leaving, "friend-of-leaving@example.test", "admin");
      const byDemoted = yield* invite(id, demoted, "friend-of-demoted@example.test", "admin");
      const members = `/api/organizations/${id}/members`;
      const listed = yield* call("GET", members, undefined, admin).pipe(
        Effect.flatMap(json),
        Effect.flatMap(readMembers),
      );
      const userOf = (email: string) =>
        listed.members.find((member) => member.email === email)?.userId;

      const removed = yield* call(
        "DELETE",
        `${members}/${userOf("leaving-admin@example.test")}`,
        undefined,
        admin,
      );
      const changed = yield* call(
        "PATCH",
        `${members}/${userOf("demoted-admin@example.test")}`,
        { role: "reviewer" },
        admin,
      );
      const withToken = yield* Effect.promise(() =>
        env.TEST_WORKER.fetch(new URL("/api/organizations", origin), {
          headers: { authorization: `Bearer ${secret}` },
        }),
      );
      const accepted = yield* Effect.forEach([byLeaving, byDemoted], ({ token: link }) =>
        call("POST", "/api/invitations/accept", { token: link, name: "Friend", password }),
      );

      assert.deepEqual([removed.status, changed.status], [204, 200]);
      assert.strictEqual(withToken.status, 401);
      assert.deepEqual(
        accepted.map(({ status }) => status),
        [404, 404],
      );
    }),
);
