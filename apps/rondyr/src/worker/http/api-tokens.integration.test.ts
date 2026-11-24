import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { makeRpcStub, type RpcCallError } from "@alchemy.run/cloudflare/Workers/Rpc";
import { assert, beforeAll, it, vi } from "@effect/vitest";
import { hashPassword } from "better-auth/crypto";
import { Clock, Effect, Redacted, Schema } from "effect";
import { Hex } from "effect/encoding";

import { testOrigin as origin } from "../../../tests/integration/auth-fixture.ts";
import {
  call,
  createInbox,
  json,
  signIn,
} from "../../../tests/integration/organization-fixture.ts";
import { CreatedApiToken } from "../../domain/organizations/api-token.ts";
import { SubmissionDismissed } from "../../domain/submissions/dismiss-submission.command.ts";
import { InboxOrganizationWithForms } from "../../domain/submissions/inbox-setup.ts";
import { InboxPage, OrganizationCounts, SubmissionDetail } from "../../domain/submissions/inbox.ts";
import { SubmissionAccepted } from "../../domain/submissions/submission-accepted.event.ts";
import { SubmissionId, UserId } from "../../domain/submissions/submission.id.ts";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

const readCreated = Schema.decodeUnknownEffect(CreatedApiToken);
const readInboxes = Schema.decodeUnknownEffect(Schema.Array(InboxOrganizationWithForms));
const readPage = Schema.decodeUnknownEffect(InboxPage);
const readCounts = Schema.decodeUnknownEffect(OrganizationCounts);
const readDetail = Schema.decodeUnknownEffect(SubmissionDetail);
const readAccepted = Schema.decodeUnknownEffect(Schema.Struct({ "submission-id": SubmissionId }));
const readEvents = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ event: Schema.Unknown })),
);

const tokensPath = (id: string) => `/api/organizations/${id}/api-tokens`;

const createToken = Effect.fnUntraced(function* (id: string, cookie: string, name = "Site inbox") {
  const response = yield* call("POST", tokensPath(id), { name }, { cookie });
  assert.strictEqual(response.status, 201);
  assert.strictEqual(response.headers.get("cache-control"), "no-store");
  return yield* json(response).pipe(Effect.flatMap(readCreated));
});

const tokenRequest = (
  method: string,
  path: string,
  token: Redacted.Redacted<string>,
  cookie?: string,
) =>
  Effect.promise(() => {
    const headers = new Headers({ authorization: `Bearer ${Redacted.value(token)}` });
    if (cookie !== undefined) headers.set("cookie", cookie);
    return env.TEST_WORKER.fetch(new URL(path, origin), { method, headers });
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

const otherAccount = Effect.fnUntraced(function* () {
  const id = "api-token-outsider";
  const credentials = {
    email: "api-token-outsider@example.test",
    password: "api-token-test-password",
  };
  const password = yield* Effect.promise(() => hashPassword(credentials.password));
  const now = yield* Clock.currentTimeMillis;
  yield* Effect.promise(() =>
    env.DB.batch([
      env.DB.prepare(
        "INSERT INTO auth_users (id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(id, "Other reviewer", credentials.email, now, now),
      env.DB.prepare(`
      INSERT INTO auth_accounts (id, user_id, account_id, provider_id, password, created_at, updated_at)
      VALUES (?, ?, ?, 'credential', ?, ?, ?)
    `).bind(id, id, id, password, now, now),
    ]),
  );
  const response = yield* call("POST", "/api/auth/sign-in/email", credentials);
  assert.strictEqual(response.status, 200);
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  assert.isNotEmpty(cookie);
  return { cookie };
});

const recordedEvents = (id: SubmissionId) => {
  const stub = env["Submissions.SubmissionAggregate"].getByName(id);
  const history = makeRpcStub<{ after: (seq: number) => Effect.Effect<unknown, RpcCallError> }>(
    stub,
  );
  return history.after(0).pipe(Effect.flatMap(readEvents));
};

it.live("creates a token once and stores only its hash and suffix", () =>
  Effect.gen(function* () {
    const { cookie } = yield* signIn;
    const { id } = yield* createInbox("Token issuance", { cookie });
    const created = yield* createToken(id, cookie, "  Site inbox  ");
    const raw = Redacted.value(created.token);

    const listed = yield* call("GET", tokensPath(id), undefined, { cookie });
    const stored = yield* Effect.promise(() =>
      env.DB.prepare("SELECT token_hash, token_suffix, created_by FROM api_tokens WHERE id = ?")
        .bind(created.id)
        .first(),
    );
    const digest = yield* Effect.promise(() =>
      crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)),
    );

    assert.isTrue(/^rdr_[A-Za-z0-9_-]{43}$/u.test(raw));
    assert.strictEqual(created.suffix, raw.slice(-4));
    assert.strictEqual(listed.status, 200);
    const metadata = yield* json(listed);
    assert.deepEqual(metadata, [
      {
        id: created.id,
        name: "Site inbox",
        suffix: created.suffix,
        createdAt: created.createdAt,
      },
    ]);
    assert.deepInclude(stored, {
      token_hash: Hex.encode(new Uint8Array(digest)),
      token_suffix: created.suffix,
    });
    assert.isString(stored?.created_by);
  }),
);

it.live("returns 401 for unknown or revoked credentials even with a valid cookie", () =>
  Effect.gen(function* () {
    const { cookie } = yield* signIn;
    const { id } = yield* createInbox("Revocation", { cookie });
    const { token, id: tokenId } = yield* createToken(id, cookie);
    const removed = yield* call("DELETE", `${tokensPath(id)}?id=${tokenId}`, undefined, { cookie });
    assert.strictEqual(removed.status, 204);

    const unknown = yield* tokenRequest(
      "GET",
      "/api/organizations",
      Redacted.make(`rdr_${"A".repeat(43)}`),
      cookie,
    );
    const revoked = yield* tokenRequest("GET", "/api/organizations", token, cookie);

    assert.strictEqual(unknown.status, 401);
    assert.strictEqual(revoked.status, 401);
    const body = yield* Effect.promise(() => revoked.text());
    assert.strictEqual(body, "");
  }),
);

it.live("lists just the token's organization", () =>
  Effect.gen(function* () {
    const { cookie } = yield* signIn;
    const own = yield* createInbox("Token organization", { cookie });
    yield* createInbox("Other token organization", { cookie });
    const { token } = yield* createToken(own.id, cookie);

    const listed = yield* tokenRequest("GET", "/api/organizations", token, cookie);

    assert.strictEqual(listed.status, 200);
    const inboxes = yield* json(listed).pipe(Effect.flatMap(readInboxes));
    // The token acts as a reviewer of its organization, whatever the role of its creator.
    assert.strictEqual(own.role, "admin");
    assert.deepEqual(inboxes, [{ ...own, role: "reviewer" }]);
  }),
);

it.live(
  "returns 404 to a token for every review route of another organization and its messages",
  () =>
    Effect.gen(function* () {
      const session = yield* signIn;
      const own = yield* createInbox("Token organization", session);
      const other = yield* createInbox("Other token organization", session);
      const otherForm = other.forms[0];
      if (otherForm === undefined) return assert.fail("Expected the contact form");
      const honeypot = yield* call(
        "PUT",
        `/api/organizations/${other.id}/forms/${otherForm.publicId}/honeypot`,
        { field: "_hp" },
        session,
      );
      assert.strictEqual(honeypot.status, 200);
      const foreignId = yield* quarantine(otherForm.publicId);
      const { token } = yield* createToken(own.id, session.cookie);
      yield* createToken(other.id, session.cookie);
      const otherPath = `/api/organizations/${other.id}/submissions`;
      const ownPath = `/api/organizations/${own.id}/submissions`;

      const requests = [
        ["GET", otherPath],
        ["GET", `/api/organizations/${other.id}/submission-counts`],
        ["GET", `${otherPath}/${foreignId}`],
        ["POST", `${otherPath}/${foreignId}/approve`],
        ["POST", `${otherPath}/${foreignId}/dismiss`],
        ["GET", `${ownPath}/${foreignId}`],
        ["POST", `${ownPath}/${foreignId}/approve`],
        ["POST", `${ownPath}/${foreignId}/dismiss`],
      ] as const;
      const statuses = yield* Effect.forEach(requests, ([method, path]) =>
        tokenRequest(method, path, token, session.cookie).pipe(
          Effect.map(({ status }) => [method, path, status]),
        ),
      );

      assert.deepEqual(
        statuses,
        requests.map(([method, path]) => [method, path, 404]),
      );
      const status = yield* Effect.promise(() =>
        env.DB.prepare("SELECT status FROM submission_inbox WHERE submission_id = ?")
          .bind(foreignId)
          .first("status"),
      );
      assert.strictEqual(status, "quarantined");
    }),
  35_000,
);

it.live("returns 403 to a token on every other API route, even with a member's cookie", () =>
  Effect.gen(function* () {
    const { cookie } = yield* signIn;
    const { id, forms } = yield* createInbox("Forbidden token routes", { cookie });
    const form = forms[0];
    if (form === undefined) return assert.fail("Expected the contact form");
    const orgPath = `/api/organizations/${id}`;
    const formPath = `${orgPath}/forms/${form.publicId}`;
    const targetPath = `${orgPath}/targets/example-target`;
    const deliveriesPath = `${orgPath}/submissions/example/deliveries`;
    const { token } = yield* createToken(id, cookie);

    const requests = [
      ["GET", "/api/auth/get-session"],
      ["POST", "/api/auth/sign-in/email"],
      ["POST", "/api/auth/sign-out"],
      ["POST", "/api/setup"],
      ["GET", "/api/operations"],
      ["POST", "/api/organizations"],
      ["GET", tokensPath(id)],
      ["POST", tokensPath(id)],
      ["DELETE", tokensPath(id)],
      ["GET", `${orgPath}/domains`],
      ["POST", `${orgPath}/domains`],
      ["DELETE", `${orgPath}/domains`],
      ["GET", `${orgPath}/classification-policy`],
      ["PUT", `${orgPath}/classification-policy`],
      ["DELETE", `${orgPath}/classification-policy`],
      ["GET", `${orgPath}/quotas`],
      ["PUT", `${orgPath}/quotas`],
      ["POST", `${orgPath}/forms`],
      ["PATCH", formPath],
      ["POST", `${formPath}/suspend`],
      ["POST", `${formPath}/reactivate`],
      ["PUT", `${formPath}/success-url`],
      ["DELETE", `${formPath}/success-url`],
      ["PUT", `${formPath}/honeypot`],
      ["DELETE", `${formPath}/honeypot`],
      ["GET", `${formPath}/turnstile`],
      ["PUT", `${formPath}/turnstile`],
      ["DELETE", `${formPath}/turnstile`],
      ["GET", `${formPath}/origins`],
      ["POST", `${formPath}/origins`],
      ["DELETE", `${formPath}/origins`],
      ["GET", `${formPath}/targets`],
      ["POST", `${formPath}/targets`],
      ["POST", `${targetPath}/rotate-secret`],
      ["PUT", `${targetPath}/recipients`],
      ["POST", `${targetPath}/activate`],
      ["POST", `${targetPath}/test`],
      ["GET", deliveriesPath],
      ["POST", `${deliveriesPath}/example-delivery/retry`],
      ["POST", `${orgPath}/submissions/example/disallowed-decision`],
      ["DELETE", `${orgPath}/submissions/73123ee4-40bf-4c5f-b8ff-1d56cdaa7640`],
      ["GET", `${orgPath}/submission-export?format=csv`],
      ["GET", `${orgPath}/retention`],
      ["PUT", `${orgPath}/retention`],
      ["GET", `${orgPath}/members`],
      ["PATCH", `${orgPath}/members/example-user`],
      ["DELETE", `${orgPath}/members/example-user`],
      ["POST", `${orgPath}/invitations`],
      ["DELETE", `${orgPath}/invitations`],
      ["POST", `${targetPath}/confirmations`],
      ["POST", "/api/invitations/read"],
      ["POST", "/api/invitations/accept"],
      ["POST", "/api/recipient-confirmations"],
    ] as const;
    const statuses = yield* Effect.forEach(requests, ([method, path]) =>
      tokenRequest(method, path, token, cookie).pipe(
        Effect.map(({ status }) => [method, path, status]),
      ),
    );

    assert.deepEqual(
      statuses,
      requests.map(([method, path]) => [method, path, 403]),
    );
  }),
);

it.live("requires organization membership to manage API tokens", () =>
  Effect.gen(function* () {
    const { cookie } = yield* signIn;
    const { id } = yield* createInbox("Private tokens", { cookie });
    const { id: tokenId } = yield* createToken(id, cookie);
    yield* Effect.promise(() =>
      env.DB.prepare("DELETE FROM organization_members WHERE organization_id = ?").bind(id).run(),
    );

    const noSession = yield* call("GET", tokensPath(id));
    const listed = yield* call("GET", tokensPath(id), undefined, { cookie });
    const created = yield* call("POST", tokensPath(id), { name: "Other token" }, { cookie });
    const revoked = yield* call("DELETE", `${tokensPath(id)}?id=${tokenId}`, undefined, { cookie });

    assert.strictEqual(noSession.status, 401);
    assert.deepEqual([listed.status, created.status, revoked.status], [404, 404, 404]);
  }),
);

it.live(
  "admits ten active tokens under concurrent creation and frees a slot when one is revoked",
  () =>
    Effect.gen(function* () {
      const { cookie } = yield* signIn;
      const session = { cookie };
      const { id } = yield* createInbox("Token limit", session);
      const first = yield* createToken(id, cookie);
      yield* Effect.forEach(
        Array.from({ length: 8 }, (_, index) => `Client ${index + 2}`),
        (name) => createToken(id, cookie, name),
      );
      const path = tokensPath(id);

      const results = yield* Effect.all(
        [
          call("POST", path, { name: "Client A" }, session),
          call("POST", path, { name: "Client B" }, session),
        ],
        { concurrency: "unbounded" },
      );

      assert.deepEqual(results.map(({ status }) => status).toSorted(), [201, 409]);
      const revoked = yield* call("DELETE", `${path}?id=${first.id}`, undefined, session);
      assert.strictEqual(revoked.status, 204);
      yield* createToken(id, cookie, "Replacement");
    }),
);

it.live(
  "reads and decides submissions without Origin, with the token taking priority over a different account",
  () =>
    Effect.gen(function* () {
      const session = yield* signIn;
      const { cookie: outsiderCookie } = yield* otherAccount();
      const outsider = yield* call("GET", "/api/organizations", undefined, {
        cookie: outsiderCookie,
      });
      assert.strictEqual(outsider.status, 200);
      const outsiderInboxes = yield* json(outsider);
      assert.deepEqual(outsiderInboxes, []);
      const { id, forms } = yield* createInbox("Token submissions", session);
      const form = forms[0];
      if (form === undefined) return assert.fail("Expected the contact form");
      const orgPath = `/api/organizations/${id}`;
      const updated = yield* call(
        "PUT",
        `${orgPath}/forms/${form.publicId}/honeypot`,
        { field: "_hp" },
        session,
      );
      assert.strictEqual(updated.status, 200);
      const acceptedId = yield* quarantine(form.publicId);
      const dismissedId = yield* quarantine(form.publicId);
      const { id: apiTokenId, token } = yield* createToken(id, session.cookie);

      const listPath = `${orgPath}/submissions`;
      const listed = yield* tokenRequest("GET", listPath, token);
      const counted = yield* tokenRequest("GET", `${orgPath}/submission-counts`, token);
      const detail = yield* tokenRequest("GET", `${listPath}/${acceptedId}`, token);
      const accepted = yield* tokenRequest(
        "POST",
        `${listPath}/${acceptedId}/approve`,
        token,
        outsiderCookie,
      );
      const dismissed = yield* tokenRequest("POST", `${listPath}/${dismissedId}/dismiss`, token);

      assert.deepEqual(
        [listed.status, counted.status, detail.status, accepted.status, dismissed.status],
        [200, 200, 200, 200, 200],
      );
      const page = yield* json(listed).pipe(Effect.flatMap(readPage));
      assert.sameMembers(
        page.entries.map(({ submissionId }) => submissionId),
        [acceptedId, dismissedId],
      );
      const totals = yield* json(counted).pipe(Effect.flatMap(readCounts));
      assert.strictEqual(totals.quarantined, 2);
      const message = yield* json(detail).pipe(Effect.flatMap(readDetail));
      assert.strictEqual(message.submissionId, acceptedId);
      assert.strictEqual(
        (yield* json(accepted).pipe(Effect.flatMap(readDetail))).status,
        "accepted",
      );
      assert.strictEqual(
        (yield* json(dismissed).pipe(Effect.flatMap(readDetail))).status,
        "archived",
      );

      const acceptance = (yield* recordedEvents(acceptedId)).at(-1)?.event;
      const dismissal = (yield* recordedEvents(dismissedId)).at(-1)?.event;
      assert.deepEqual(acceptance, {
        _tag: "SubmissionAccepted",
        organizationId: id,
        acceptance: { _tag: "Manual", apiTokenId },
      });
      assert.deepEqual(dismissal, { _tag: "SubmissionDismissed", organizationId: id, apiTokenId });
    }),
  35_000,
);

it.effect("decodes manual decisions as they were stored before API tokens", () =>
  Effect.gen(function* () {
    const accepted = yield* Schema.decodeEffect(Schema.fromJsonString(SubmissionAccepted))(
      '{"_tag":"SubmissionAccepted","organizationId":"pottery","acceptance":{"_tag":"Manual","reviewerId":"reviewer"}}',
    );
    const dismissed = yield* Schema.decodeEffect(Schema.fromJsonString(SubmissionDismissed))(
      '{"_tag":"SubmissionDismissed","organizationId":"pottery","reviewerId":"reviewer"}',
    );

    assert.deepEqual(accepted.acceptance, { _tag: "Manual", reviewerId: UserId.make("reviewer") });
    assert.strictEqual(dismissed.reviewerId, "reviewer");
  }),
);
