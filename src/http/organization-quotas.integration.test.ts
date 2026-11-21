import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, beforeAll, it, vi } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { testOrigin } from "../../tests/integration/auth-fixture.ts";
import { call, createInbox, json, signIn } from "../../tests/integration/organization-fixture.ts";
import { ManagedForm } from "../domain/forms/form.ts";
import { turnstileField } from "../domain/forms/turnstile.ts";
import { DailyUsage, type DailyQuotas } from "../domain/organizations/organization-quotas.ts";
import { SubmissionDetail } from "../domain/submissions/inbox.ts";
import { SubmissionId } from "../domain/submissions/submission.id.ts";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

const readUsage = Schema.decodeUnknownEffect(DailyUsage);
const readForm = Schema.decodeUnknownEffect(ManagedForm);
const readDetail = Schema.decodeUnknownPromise(SubmissionDetail);
const readAccepted = Schema.decodeUnknownEffect(Schema.Struct({ "submission-id": SubmissionId }));
const readReasons = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ reason: Schema.NullOr(Schema.String) })),
);
const quotaPath = (org: string) => `/api/organizations/${org}/quotas`;
const formPath = (org: string, form: { readonly publicId: string }) =>
  `/api/organizations/${org}/forms/${form.publicId}`;

const configure = Effect.fnUntraced(function* (name: string, limits: DailyQuotas) {
  const headers = yield* signIn;
  const organization = yield* createInbox(name, headers);
  const form = organization.forms[0];
  if (form === undefined) return assert.fail("Expected a form");
  const path = quotaPath(organization.id);
  const updated = yield* call("PUT", path, limits, headers);
  assert.strictEqual(updated.status, 200);
  return { organization, form, headers, path };
});

// The honeypot field of the forms below. Junk fills it in.
const honeypotField = "company";
const trap = Effect.fnUntraced(function* (
  organizationId: string,
  form: { readonly publicId: string },
  headers: HeadersInit,
) {
  const set = yield* call(
    "PUT",
    `${formPath(organizationId, form)}/honeypot`,
    { field: honeypotField },
    headers,
  );
  assert.strictEqual(set.status, 200);
});

const usage = (path: string, headers: HeadersInit) =>
  call("GET", path, undefined, headers).pipe(Effect.flatMap(json), Effect.flatMap(readUsage));
const submit = (form: { readonly publicId: string }, message: string) =>
  call("POST", `/f/${form.publicId}`, { message, "fixture-verdict": "accept" });
const submitJunk = (form: { readonly publicId: string }, message: string) =>
  call("POST", `/f/${form.publicId}`, {
    message,
    [honeypotField]: "Robot Inc.",
    "fixture-verdict": "accept",
  });
const acceptedId = Effect.fnUntraced(function* (response: Response) {
  assert.strictEqual(response.status, 202);
  const { "submission-id": id } = yield* json(response).pipe(Effect.flatMap(readAccepted));
  return id;
});

/** D1's clock, in Unix seconds. Intake takes the time of a refusal from it. */
const d1Clock = Effect.promise(() =>
  env.DB.prepare("SELECT unixepoch() AS now").first<number>("now"),
).pipe(Effect.map((now) => now ?? assert.fail("Expected the time from D1")));

interface Interval {
  readonly start: number;
  readonly end: number;
}

/** Run `request` between two readings of D1's clock, which bound when intake decided. */
const timed = <A, E, R>(request: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const start = yield* d1Clock;
    const result = yield* request;
    const end = yield* d1Clock;
    return { result, during: { start, end } satisfies Interval };
  });

const secondsToMidnight = (at: number) => 86_400 - (at % 86_400);

/**
 * Assert a refusal by a daily quota: `429`, readable by a page, with `Retry-After` set to the
 * seconds from the refusal to the next midnight UTC. The refusal happened `during` the request,
 * so the header is between the seconds left at its end and the seconds left at its start.
 */
function assertRefusedUntilMidnight(response: Response, during: Interval) {
  assert.strictEqual(response.status, 429);
  assert.match(response.headers.get("access-control-expose-headers") ?? "", /retry-after/u);
  const retryAfter = Number(response.headers.get("retry-after"));
  const atStart = secondsToMidnight(during.start);
  const atEnd = secondsToMidnight(during.end);
  // Across midnight UTC, the request ends with more seconds left than it started with.
  const sameDay = atEnd <= atStart;
  assert.isTrue(
    sameDay
      ? atEnd <= retryAfter && retryAfter <= atStart
      : retryAfter <= atStart || atEnd <= retryAfter,
    `Retry-After is ${retryAfter}; the seconds to midnight UTC went from ${atStart} to ${atEnd} during the request`,
  );
}

const storedReasons = (organizationId: string) =>
  Effect.promise(() =>
    env.DB.prepare(
      "SELECT intake_reason AS reason FROM submissions WHERE organization_id = ? ORDER BY received_at",
    )
      .bind(organizationId)
      .all(),
  ).pipe(Effect.flatMap(({ results }) => readReasons(results)));

const classified = (organizationId: string, id: SubmissionId, headers: HeadersInit) =>
  Effect.promise(() =>
    vi.waitFor(
      () =>
        env.TEST_WORKER.fetch(
          new URL(`/api/organizations/${organizationId}/submissions/${id}`, testOrigin),
          { headers },
        )
          .then((response) => response.json())
          .then(readDetail)
          .then((submission) => {
            assert.oneOf(submission.status, ["accepted", "quarantined"]);
            return submission;
          }),
      { timeout: 15_000, interval: 100 },
    ),
  );

/** Wait for the hand-off of a submission, then deliver its queue message a second time. */
const redeliver = Effect.fnUntraced(function* (id: SubmissionId) {
  const waitForHandoff = () =>
    vi.waitFor(
      () =>
        env.DB.prepare("SELECT handed_off_at FROM outbox_events WHERE submission_id = ?")
          .bind(id)
          .first("handed_off_at")
          .then((value) => assert.isNumber(value)),
      { timeout: 15_000, interval: 100 },
    );
  yield* Effect.promise(waitForHandoff);
  yield* Effect.promise(() =>
    env.DB.prepare("UPDATE outbox_events SET handed_off_at = NULL WHERE submission_id = ?")
      .bind(id)
      .run(),
  );
  yield* Effect.promise(() => env.CLASSIFICATION_QUEUE.send({ submissionId: id }));
  yield* Effect.promise(waitForHandoff);
});

const projectionVersion = (id: SubmissionId) =>
  Effect.promise(() =>
    env.DB.prepare("SELECT version FROM submission_inbox WHERE submission_id = ?")
      .bind(id)
      .first("version"),
  );

it.live("returns default quotas and refuses out-of-range or cross-organization changes", () =>
  Effect.gen(function* () {
    const headers = yield* signIn;
    const inbox = yield* createInbox("Quota settings", headers);
    const path = quotaPath(inbox.id);
    yield* Effect.promise(() =>
      env.DB.prepare(
        "INSERT INTO organizations (id, name) VALUES ('foreign-quotas', 'Foreign')",
      ).run(),
    );

    const initial = yield* usage(path, headers);
    assert.deepEqual(initial.limits, { submissions: 2000, classifications: 1000 });
    assert.deepEqual(initial.used, { submissions: 0, classifications: 0, junk: 0 });
    const [zeroStorage, fractional, tooHigh, anonymous, foreignRead, foreignWrite] =
      yield* Effect.all(
        [
          call("PUT", path, { submissions: 0, classifications: 0 }, headers),
          call("PUT", path, { submissions: 2, classifications: 0.5 }, headers),
          call("PUT", path, { submissions: 2, classifications: 100001 }, headers),
          call("GET", path),
          call("GET", quotaPath("foreign-quotas"), undefined, headers),
          call("PUT", quotaPath("foreign-quotas"), { submissions: 2, classifications: 0 }, headers),
        ],
        { concurrency: "unbounded" },
      );
    assert.deepEqual(
      [zeroStorage, fractional, tooHigh, anonymous, foreignRead, foreignWrite].map(
        ({ status }) => status,
      ),
      [400, 400, 400, 401, 404, 404],
    );
    assert.deepEqual((yield* usage(path, headers)).limits, initial.limits);
  }),
);

it.live("enforces the exact submission quota across concurrent posts on different forms", () =>
  Effect.gen(function* () {
    const { organization, form, headers, path } = yield* configure("Quota storage boundary", {
      submissions: 2,
      classifications: 10,
    });
    const sibling = yield* call(
      "POST",
      `/api/organizations/${organization.id}/forms`,
      { name: "Sibling" },
      headers,
    ).pipe(Effect.flatMap(json), Effect.flatMap(readForm));
    const first = yield* submit(form, "Storage quota first");
    assert.strictEqual(first.status, 202);

    const { result: responses, during } = yield* timed(
      Effect.all([submit(form, "Storage quota left"), submit(sibling, "Storage quota right")], {
        concurrency: "unbounded",
      }),
    );

    assert.sameMembers(
      responses.map(({ status }) => status),
      [202, 429],
    );
    const refused = responses.find(({ status }) => status === 429);
    if (refused === undefined) return assert.fail("Expected one refused submission");
    assertRefusedUntilMidnight(refused, during);
    assert.deepEqual((yield* usage(path, headers)).used, {
      submissions: 2,
      classifications: 2,
      junk: 0,
    });
    const row = yield* Effect.promise(() =>
      env.DB.prepare(`
      SELECT COUNT(*) AS stored, COUNT(o.submission_id) AS queued
      FROM submissions s LEFT JOIN outbox_events o ON s.id = o.submission_id
      WHERE s.organization_id = ?
    `)
        .bind(organization.id)
        .first(),
    );
    assert.deepEqual(row, { stored: 2, queued: 2 });
  }),
);

it.live(
  "keeps accepting other submissions once junk has used up its own daily budget",
  () =>
    Effect.gen(function* () {
      const { organization, form, headers, path } = yield* configure("Junk budget full", {
        submissions: 3,
        classifications: 10,
      });
      yield* trap(organization.id, form, headers);
      const secretKey = "junk-budget-secret";
      const turnstile = yield* call(
        "PUT",
        `${formPath(organization.id, form)}/turnstile`,
        { siteKey: "junk_budget_site_key", secretKey },
        headers,
      );
      assert.strictEqual(turnstile.status, 200);
      const token = { [turnstileField]: `valid-${secretKey}` };
      const repeated = { message: "Junk budget repeated", "fixture-verdict": "accept", ...token };
      const post = (fields: Schema.Json) => call("POST", `/f/${form.publicId}`, fields);
      // Two copies of a message are stored as usual. The third is a repetition.
      const filled = yield* Effect.forEach(
        [
          repeated,
          repeated,
          repeated,
          { message: "Junk budget trap", [honeypotField]: "Robot Inc.", ...token },
          { message: "Junk budget without a token", "fixture-verdict": "accept" },
        ],
        post,
      );
      assert.deepEqual(
        filled.map(({ status }) => status),
        [202, 202, 202, 202, 202],
      );

      const junk = yield* timed(
        post({ message: "Junk over budget", [honeypotField]: "Robot", ...token }),
      );
      const real = yield* post({
        message: "A real question after the wave",
        "fixture-verdict": "accept",
        ...token,
      });

      assertRefusedUntilMidnight(junk.result, junk.during);
      const id = yield* acceptedId(real);
      assert.strictEqual((yield* classified(organization.id, id, headers)).status, "accepted");
      assert.deepEqual((yield* usage(path, headers)).used, {
        submissions: 3,
        classifications: 3,
        junk: 3,
      });
      assert.deepEqual(
        (yield* storedReasons(organization.id)).map(({ reason }) => reason),
        [null, null, "repetition", "honeypot", "turnstile-failed", null],
      );
    }),
  30_000,
);

it.live(
  "keeps quarantining junk after the other submissions used up their budget",
  () =>
    Effect.gen(function* () {
      const { organization, form, headers, path } = yield* configure("Junk after full budget", {
        submissions: 1,
        classifications: 10,
      });
      yield* trap(organization.id, form, headers);
      assert.strictEqual((yield* submit(form, "Budget first")).status, 202);
      const full = yield* timed(submit(form, "Budget refused"));
      assertRefusedUntilMidnight(full.result, full.during);

      const kept = yield* submitJunk(form, "Junk within its budget");
      const refused = yield* timed(submitJunk(form, "Junk over its budget"));

      const id = yield* acceptedId(kept);
      const detail = yield* classified(organization.id, id, headers);
      assert.deepEqual([detail.status, detail.reason], ["quarantined", "honeypot"]);
      assertRefusedUntilMidnight(refused.result, refused.during);
      assert.deepEqual((yield* usage(path, headers)).used, {
        submissions: 1,
        classifications: 1,
        junk: 1,
      });
    }),
  25_000,
);

it.live("enforces the exact junk budget across concurrent posts on different forms", () =>
  Effect.gen(function* () {
    const { organization, form, headers, path } = yield* configure("Junk budget boundary", {
      submissions: 2,
      classifications: 10,
    });
    const sibling = yield* call(
      "POST",
      `/api/organizations/${organization.id}/forms`,
      { name: "Sibling" },
      headers,
    ).pipe(Effect.flatMap(json), Effect.flatMap(readForm));
    yield* trap(organization.id, form, headers);
    yield* trap(organization.id, sibling, headers);
    assert.strictEqual((yield* submitJunk(form, "Junk budget first")).status, 202);

    const { result: responses, during } = yield* timed(
      Effect.all([submitJunk(form, "Junk budget left"), submitJunk(sibling, "Junk budget right")], {
        concurrency: "unbounded",
      }),
    );

    assert.sameMembers(
      responses.map(({ status }) => status),
      [202, 429],
    );
    const refused = responses.find(({ status }) => status === 429);
    if (refused === undefined) return assert.fail("Expected one refused submission");
    assertRefusedUntilMidnight(refused, during);
    assert.deepEqual((yield* usage(path, headers)).used, {
      submissions: 0,
      classifications: 0,
      junk: 2,
    });
    const row = yield* Effect.promise(() =>
      env.DB.prepare(`
      SELECT COUNT(*) AS stored, COUNT(o.submission_id) AS queued
      FROM submissions s LEFT JOIN outbox_events o ON s.id = o.submission_id
      WHERE s.organization_id = ?
    `)
        .bind(organization.id)
        .first(),
    );
    assert.deepEqual(row, { stored: 2, queued: 2 });
  }),
);

it.live(
  "quarantines exactly the submissions that exceed the concurrent classification quota",
  () =>
    Effect.gen(function* () {
      const { organization, form, headers, path } = yield* configure(
        "Quota classification boundary",
        { submissions: 10, classifications: 2 },
      );
      const first = yield* submit(form, "Model quota first");
      const firstId = yield* acceptedId(first);
      const markers = ["Model quota left", "Model quota right"] as const;

      const responses = yield* Effect.all([submit(form, markers[0]), submit(form, markers[1])], {
        concurrency: "unbounded",
      });

      const ids = yield* Effect.forEach(responses, acceptedId);
      const details = yield* Effect.forEach([firstId, ...ids], (id) =>
        classified(organization.id, id, headers),
      );
      assert.strictEqual(details[0]?.status, "accepted");
      assert.sameMembers(
        details.slice(1).map(({ reason }) => reason),
        [null, "quota"],
      );
      // A quota quarantine can be a real message, so it uses the budget of submissions.
      assert.deepEqual((yield* usage(path, headers)).used, {
        submissions: 3,
        classifications: 2,
        junk: 0,
      });
      const quarantined = details.find(({ reason }) => reason === "quota");
      if (quarantined === undefined) return assert.fail("Expected one quota quarantine");
      const ai = yield* Effect.promise(() =>
        env.WORKERS_AI_FIXTURE.fetch("https://workers-ai.test/__calls"),
      );
      const calls = yield* json(ai).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Array(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
          ),
        ),
      );
      assert.isFalse(calls.some((message) => message?.message === quarantined.fields.message));
    }),
  30_000,
);

it.live(
  "keeps a quota quarantine and its counters when the queue delivers the event again",
  () =>
    Effect.gen(function* () {
      const { organization, form, headers, path } = yield* configure("Quota duplicate hand-off", {
        submissions: 5,
        classifications: 0,
      });
      const response = yield* submit(form, "Quota duplicate message");
      const id = yield* acceptedId(response);

      yield* redeliver(id);

      const detail = yield* classified(organization.id, id, headers);
      assert.strictEqual(detail.reason, "quota");
      const version = yield* projectionVersion(id);
      assert.strictEqual(version, 1);
      assert.deepEqual((yield* usage(path, headers)).used, {
        submissions: 1,
        classifications: 0,
        junk: 0,
      });
    }),
  35_000,
);

it.live(
  "keeps a junk quarantine and its counters when the queue delivers the event again",
  () =>
    Effect.gen(function* () {
      const { organization, form, headers, path } = yield* configure("Junk duplicate hand-off", {
        submissions: 5,
        classifications: 10,
      });
      yield* trap(organization.id, form, headers);
      const response = yield* submitJunk(form, "Junk duplicate message");
      const id = yield* acceptedId(response);

      yield* redeliver(id);

      const detail = yield* classified(organization.id, id, headers);
      assert.strictEqual(detail.reason, "honeypot");
      const version = yield* projectionVersion(id);
      assert.strictEqual(version, 1);
      assert.deepEqual((yield* usage(path, headers)).used, {
        submissions: 0,
        classifications: 0,
        junk: 1,
      });
    }),
  35_000,
);

it.live(
  "starts fresh at the next UTC day even when every quota was full",
  () =>
    Effect.gen(function* () {
      const { organization, form, headers, path } = yield* configure("Quota UTC reset", {
        submissions: 1,
        classifications: 1,
      });
      yield* trap(organization.id, form, headers);
      yield* Effect.promise(() =>
        env.DB.prepare(`
      INSERT INTO organization_daily_usage (organization_id, day, submissions, classifications, junk)
      VALUES (?, date('now', '-1 day'), 1, 1, 1)
    `)
          .bind(organization.id)
          .run(),
      );
      assert.deepEqual((yield* usage(path, headers)).used, {
        submissions: 0,
        classifications: 0,
        junk: 0,
      });

      const received = yield* submit(form, "Quota reopened");
      const junk = yield* submitJunk(form, "Junk budget reopened");

      const id = yield* acceptedId(received);
      assert.strictEqual((yield* classified(organization.id, id, headers)).status, "accepted");
      assert.strictEqual(junk.status, 202);
      assert.deepEqual((yield* usage(path, headers)).used, {
        submissions: 1,
        classifications: 1,
        junk: 1,
      });
    }),
  25_000,
);
