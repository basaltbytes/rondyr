import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, beforeAll, it, vi } from "@effect/vitest";
import { hashPassword } from "better-auth/crypto";
import { Clock, Effect, Schema } from "effect";

import {
  call,
  createInbox,
  json,
  signIn,
} from "../../../tests/integration/organization-fixture.ts";
import {
  confirmationToken,
  confirmByEmail,
  emailsTo,
} from "../../../tests/integration/recipient-fixture.ts";
import { EmailTarget } from "../../domain/deliveries/email.ts";
import { TargetTestResult } from "../../domain/deliveries/history.ts";
import { DestinationTarget } from "../../domain/deliveries/targets.ts";
import { SubmissionId } from "../../domain/submissions/submission.id.ts";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

const readEmailTarget = Schema.decodeUnknownEffect(EmailTarget);
const readTargets = Schema.decodeUnknownEffect(Schema.Array(DestinationTarget));
const readTest = Schema.decodeUnknownEffect(TargetTestResult);
const readAccepted = Schema.decodeUnknownEffect(Schema.Struct({ "submission-id": SubmissionId }));

let clients = 0;

/** A second account in its own organization. Each sign-in comes from its own client. */
const otherAdmin = Effect.fnUntraced(function* (id: string) {
  const email = `${id}@example.test`;
  const password = "confirmation-test-password";
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
  clients += 1;
  const response = yield* call(
    "POST",
    "/api/auth/sign-in/email",
    { email, password },
    { "cf-connecting-ip": `198.51.100.${clients}` },
  );
  assert.strictEqual(response.status, 200);
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  return { cookie };
});

/** An organization with an email destination for `recipients` on its contact form. */
const emailDestination = Effect.fnUntraced(function* (
  name: string,
  headers: HeadersInit,
  recipients: ReadonlyArray<string>,
) {
  const inbox = yield* createInbox(name, headers);
  const form = inbox.forms[0];
  if (form === undefined) return assert.fail("Expected the contact form");
  const created = yield* call(
    "POST",
    `/api/organizations/${inbox.id}/forms/${form.publicId}/targets`,
    { type: "email", recipients: [...recipients] },
    headers,
  );
  assert.strictEqual(created.status, 201);
  const target = yield* json(created).pipe(Effect.flatMap(readEmailTarget));
  return { inbox, form, target, path: `/api/organizations/${inbox.id}/targets/${target.id}` };
});

const statuses = (target: typeof EmailTarget.Type) =>
  target.recipientStatuses.map(({ address, status }) => [address, status]);

const emailTargetsOf = Effect.fnUntraced(function* (
  organizationId: string,
  publicId: string,
  headers: HeadersInit,
) {
  const listed = yield* call(
    "GET",
    `/api/organizations/${organizationId}/forms/${publicId}/targets`,
    undefined,
    headers,
  ).pipe(Effect.flatMap(json), Effect.flatMap(readTargets));
  return listed.flatMap((target) => (target.type === "email" ? [target] : []));
});

const confirm = (token: string) => call("POST", "/api/recipient-confirmations", { token });

/** Post an accepted message to a form and wait until its deliveries have finished. */
const acceptedMessage = Effect.fnUntraced(function* (publicId: string, message: string) {
  const response = yield* call("POST", `/f/${publicId}`, {
    email: "visitor@example.test",
    message,
    "fixture-verdict": "accept",
  });
  assert.strictEqual(response.status, 202);
  const { "submission-id": id } = yield* json(response).pipe(Effect.flatMap(readAccepted));
  yield* Effect.promise(() =>
    vi.waitFor(
      () =>
        env.DB.prepare(
          "SELECT count(*) AS open FROM deliveries WHERE submission_id = ? AND status NOT IN ('delivered', 'failed')",
        )
          .bind(id)
          .first("open")
          .then((open) =>
            env.DB.prepare("SELECT count(*) AS total FROM deliveries WHERE submission_id = ?")
              .bind(id)
              .first("total")
              .then((total) => {
                assert.isAbove(Number(total), 0);
                assert.strictEqual(open, 0);
              }),
          ),
      { timeout: 20_000, interval: 100 },
    ),
  );
  return id;
});

const deliveryMessages = Effect.fnUntraced(function* (recipient: string) {
  const emails = yield* emailsTo(recipient);
  return emails.filter(({ subject }) => subject.startsWith("New message"));
});

it.live("confirms a recipient once with the link of its email, which names no organization", () =>
  Effect.gen(function* () {
    const admin = yield* signIn;
    const { inbox, form, target } = yield* emailDestination("Confirmation studio", admin, [
      "first-owner@example.test",
      "second-owner@example.test",
    ]);

    const token = yield* confirmationToken("first-owner@example.test");
    const [email] = yield* emailsTo("first-owner@example.test");
    const confirmed = yield* confirm(token);
    const reused = yield* confirm(token);
    const reusedBody = yield* json(reused);
    const [listed] = yield* emailTargetsOf(inbox.id, form.publicId, admin);
    const stored = yield* Effect.promise(() =>
      env.DB.prepare(
        "SELECT token_hash, confirmed_at FROM email_recipient_confirmations WHERE address = ?",
      )
        .bind("first-owner@example.test")
        .first(),
    );

    assert.deepEqual(statuses(target), [
      ["first-owner@example.test", "pending"],
      ["second-owner@example.test", "pending"],
    ]);
    assert.strictEqual(email?.subject, "Confirm your email address for Rondyr");
    assert.notInclude(email?.text, "Confirmation studio");
    assert.notInclude(email?.text, "Contact");
    assert.strictEqual(confirmed.status, 204);
    assert.strictEqual(reused.status, 404);
    assert.deepEqual(reusedBody, { error: "confirmation-invalid" });
    assert.deepEqual(listed === undefined ? [] : statuses(listed), [
      ["first-owner@example.test", "confirmed"],
      ["second-owner@example.test", "pending"],
    ]);
    assert.strictEqual(stored?.token_hash, null);
    assert.isNumber(stored?.confirmed_at);
  }),
);

it.live("refuses an expired link", () =>
  Effect.gen(function* () {
    const admin = yield* signIn;
    yield* emailDestination("Expired link", admin, ["late-owner@example.test"]);
    const token = yield* confirmationToken("late-owner@example.test");
    const now = yield* Clock.currentTimeMillis;
    yield* Effect.promise(() =>
      env.DB.prepare(
        "UPDATE email_recipient_confirmations SET token_expires_at = ? WHERE address = ?",
      )
        .bind(now - 1, "late-owner@example.test")
        .run(),
    );

    const expired = yield* confirm(token);

    assert.strictEqual(expired.status, 404);
    const status = yield* Effect.promise(() =>
      env.DB.prepare("SELECT confirmed_at FROM email_recipient_confirmations WHERE address = ?")
        .bind("late-owner@example.test")
        .first("confirmed_at"),
    );
    assert.isNull(status);
  }),
);

it.live(
  "sends a delivery and a test to confirmed recipients only",
  () =>
    Effect.gen(function* () {
      const admin = yield* signIn;
      const { inbox, form, path } = yield* emailDestination("Confirmed delivery", admin, [
        "confirmed-owner@example.test",
        "silent-owner@example.test",
      ]);
      yield* confirmByEmail("confirmed-owner@example.test");
      const unconfirmed = yield* call(
        "POST",
        `/api/organizations/${inbox.id}/forms/${form.publicId}/targets`,
        { type: "email", recipients: ["nobody-confirmed@example.test"] },
        admin,
      ).pipe(Effect.flatMap(json), Effect.flatMap(readEmailTarget));

      const id = yield* acceptedMessage(form.publicId, "Only for confirmed recipients");
      const tested = yield* call("POST", `${path}/test`, undefined, admin).pipe(
        Effect.flatMap(json),
        Effect.flatMap(readTest),
      );
      const untested = yield* call(
        "POST",
        `/api/organizations/${inbox.id}/targets/${unconfirmed.id}/test`,
        undefined,
        admin,
      ).pipe(Effect.flatMap(json), Effect.flatMap(readTest));
      const confirmedEmails = yield* emailsTo("confirmed-owner@example.test");
      const silentEmails = yield* emailsTo("silent-owner@example.test");
      const failed = yield* Effect.promise(() =>
        env.DB.prepare(
          "SELECT status, last_error FROM deliveries WHERE submission_id = ? AND target_id = ?",
        )
          .bind(id, unconfirmed.id)
          .first(),
      );
      const inboxStatus = yield* Effect.promise(() =>
        env.DB.prepare("SELECT status FROM submission_inbox WHERE submission_id = ?")
          .bind(id)
          .first("status"),
      );

      assert.deepEqual(
        confirmedEmails.map(({ to, subject }) => [to, subject.split(":", 1)[0]]),
        [
          [["confirmed-owner@example.test"], "Confirm your email address for Rondyr"],
          [["confirmed-owner@example.test"], "New message"],
          [["confirmed-owner@example.test"], "Test message"],
        ],
      );
      assert.deepEqual(
        silentEmails.map(({ subject }) => subject),
        ["Confirm your email address for Rondyr"],
      );
      assert.strictEqual(tested.outcome, "delivered");
      assert.strictEqual(untested.outcome, "permanent-failure");
      assert.include(untested.outcome === "delivered" ? "" : untested.summary, "confirmed");
      assert.strictEqual(failed?.status, "failed");
      assert.include(String(failed?.last_error), "confirmed");
      assert.strictEqual(inboxStatus, "accepted");
    }),
  40_000,
);

it.live(
  "sends at most 3 tests a minute to a destination",
  () =>
    Effect.gen(function* () {
      const admin = yield* signIn;
      const inbox = yield* createInbox("Test limit", admin);
      const form = inbox.forms[0];
      if (form === undefined) return assert.fail("Expected the contact form");
      const created = yield* call(
        "POST",
        `/api/organizations/${inbox.id}/forms/${form.publicId}/targets`,
        { type: "webhook", url: "https://webhooks.example.test/limited/ok" },
        admin,
      ).pipe(Effect.flatMap(json));
      const { target } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ target: Schema.Struct({ id: Schema.String }) }),
      )(created);
      const testPath = `/api/organizations/${inbox.id}/targets/${target.id}/test`;

      // Twice the limit and one more: at least one window of the binding goes over it.
      const responses = yield* Effect.forEach(Array.from({ length: 7 }), () =>
        call("POST", testPath, undefined, admin),
      );
      const limited = responses.find(({ status }) => status === 429);

      assert.deepEqual(
        responses.slice(0, 3).map(({ status }) => status),
        [200, 200, 200],
      );
      assert.isDefined(limited);
      assert.strictEqual(limited?.headers.get("retry-after"), "60");
    }),
  30_000,
);

it.live("sends at most 3 confirmation emails a day to an address, across organizations", () =>
  Effect.gen(function* () {
    const admin = yield* signIn;
    const { path } = yield* emailDestination("Confirmation limit", admin, [
      "busy-owner@example.test",
    ]);
    const resend = (headers: HeadersInit, target = path) =>
      call("POST", `${target}/confirmations`, { address: "Busy-Owner@example.test" }, headers);

    const second = yield* resend(admin);
    const third = yield* resend(admin);
    const fourth = yield* resend(admin);
    const fourthBody = yield* json(fourth);
    const other = yield* otherAdmin("other-limit-admin");
    const elsewhere = yield* emailDestination("Other limit", other, ["busy-owner@example.test"]);
    const elsewhereResent = yield* resend(other, elsewhere.path);
    const emails = yield* emailsTo("busy-owner@example.test");

    assert.deepEqual([second.status, third.status, fourth.status], [202, 202, 429]);
    assert.deepEqual(fourthBody, { error: "confirmation-limit" });
    assert.isAbove(Number(fourth.headers.get("retry-after")), 0);
    assert.isAtMost(Number(fourth.headers.get("retry-after")), 86_400);
    assert.strictEqual(elsewhereResent.status, 429);
    assert.lengthOf(emails, 3);
  }),
);

it.live(
  "keeps confirmations and their routes inside each organization",
  () =>
    Effect.gen(function* () {
      const admin = yield* signIn;
      const own = yield* emailDestination("Own confirmations", admin, [
        "shared-owner@example.test",
      ]);
      const other = yield* otherAdmin("other-confirmation-admin");
      const foreign = yield* emailDestination("Foreign confirmations", other, [
        "shared-owner@example.test",
      ]);
      // The owner confirms for the other organization only, with the link of its email.
      yield* confirmByEmail("shared-owner@example.test");
      yield* Effect.promise(() =>
        env.DB.prepare("UPDATE email_recipient_confirmations SET emails_sent = 0 WHERE address = ?")
          .bind("shared-owner@example.test")
          .run(),
      );

      const listedByOther = yield* call(
        "GET",
        `/api/organizations/${own.inbox.id}/forms/${own.form.publicId}/targets`,
        undefined,
        other,
      );
      const resentByOther = yield* call(
        "POST",
        `${own.path}/confirmations`,
        { address: "shared-owner@example.test" },
        other,
      );
      const resentForeign = yield* call(
        "POST",
        `${foreign.path}/confirmations`,
        { address: "shared-owner@example.test" },
        admin,
      );
      const confirmedAgain = yield* call(
        "POST",
        `${foreign.path}/confirmations`,
        { address: "shared-owner@example.test" },
        other,
      );
      const unknown = yield* call(
        "POST",
        `${own.path}/confirmations`,
        { address: "stranger@example.test" },
        admin,
      );
      const [ownTarget] = yield* emailTargetsOf(own.inbox.id, own.form.publicId, admin);
      const [foreignTarget] = yield* emailTargetsOf(foreign.inbox.id, foreign.form.publicId, other);
      yield* acceptedMessage(own.form.publicId, "Not for an owner who confirmed elsewhere");

      assert.deepEqual(
        [listedByOther.status, resentByOther.status, resentForeign.status, unknown.status],
        [404, 404, 404, 404],
      );
      assert.strictEqual(confirmedAgain.status, 409);
      assert.deepEqual(ownTarget === undefined ? [] : statuses(ownTarget), [
        ["shared-owner@example.test", "pending"],
      ]);
      assert.deepEqual(foreignTarget === undefined ? [] : statuses(foreignTarget), [
        ["shared-owner@example.test", "confirmed"],
      ]);
      const delivered = yield* deliveryMessages("shared-owner@example.test");
      assert.lengthOf(delivered, 0);
    }),
  40_000,
);
