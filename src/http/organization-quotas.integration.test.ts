import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, beforeAll, it, vi } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { testOrigin } from "../../tests/integration/auth-fixture.ts";
import { call, createInbox, json, signIn } from "../../tests/integration/organization-fixture.ts";
import { ManagedForm } from "../domain/forms/form.ts";
import { DailyUsage, type DailyQuotas } from "../domain/organizations/organization-quotas.ts";
import { SubmissionDetail } from "../domain/submissions/inbox.ts";
import { SubmissionId } from "../domain/submissions/submission.id.ts";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

const readUsage = Schema.decodeUnknownEffect(DailyUsage);
const readForm = Schema.decodeUnknownEffect(ManagedForm);
const readDetail = Schema.decodeUnknownPromise(SubmissionDetail);
const readAccepted = Schema.decodeUnknownEffect(Schema.Struct({ "submission-id": SubmissionId }));
const quotaPath = (org: string) => `/api/organizations/${org}/quotas`;

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

const usage = (path: string, headers: HeadersInit) =>
  call("GET", path, undefined, headers).pipe(Effect.flatMap(json), Effect.flatMap(readUsage));
const submit = (form: { readonly publicId: string }, message: string) =>
  call("POST", `/f/${form.publicId}`, { message, "fixture-verdict": "accept" });
const acceptedId = Effect.fnUntraced(function* (response: Response) {
  assert.strictEqual(response.status, 202);
  const { "submission-id": id } = yield* json(response).pipe(Effect.flatMap(readAccepted));
  return id;
});

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
    assert.deepEqual(initial.used, { submissions: 0, classifications: 0 });
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

    const responses = yield* Effect.all(
      [submit(form, "Storage quota left"), submit(sibling, "Storage quota right")],
      { concurrency: "unbounded" },
    );

    assert.sameMembers(
      responses.map(({ status }) => status),
      [202, 429],
    );
    const refused = responses.find(({ status }) => status === 429);
    if (refused === undefined) return assert.fail("Expected one refused submission");
    assert.match(refused.headers.get("access-control-expose-headers") ?? "", /retry-after/u);
    const seconds = yield* Effect.promise(() =>
      env.DB.prepare("SELECT 86400 - unixepoch() % 86400 AS seconds").first<number>("seconds"),
    );
    if (seconds === null) return assert.fail("Expected the remaining seconds in the UTC day");
    assert.closeTo(Number(refused.headers.get("retry-after")), seconds, 2);
    assert.deepEqual((yield* usage(path, headers)).used, { submissions: 2, classifications: 2 });
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
      assert.deepEqual((yield* usage(path, headers)).used, { submissions: 3, classifications: 2 });
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
      const detail = yield* classified(organization.id, id, headers);
      assert.strictEqual(detail.reason, "quota");
      const version = yield* Effect.promise(() =>
        env.DB.prepare("SELECT version FROM submission_inbox WHERE submission_id = ?")
          .bind(id)
          .first("version"),
      );
      assert.strictEqual(version, 1);
      assert.deepEqual((yield* usage(path, headers)).used, { submissions: 1, classifications: 0 });
    }),
  35_000,
);

it.live(
  "starts fresh at the next UTC day even when both quotas were full",
  () =>
    Effect.gen(function* () {
      const { organization, form, headers, path } = yield* configure("Quota UTC reset", {
        submissions: 1,
        classifications: 1,
      });
      yield* Effect.promise(() =>
        env.DB.prepare(`
      INSERT INTO organization_daily_usage (organization_id, day, submissions, classifications)
      VALUES (?, date('now', '-1 day'), 1, 1)
    `)
          .bind(organization.id)
          .run(),
      );
      assert.deepEqual((yield* usage(path, headers)).used, { submissions: 0, classifications: 0 });

      const received = yield* submit(form, "Quota reopened");

      const id = yield* acceptedId(received);
      assert.strictEqual((yield* classified(organization.id, id, headers)).status, "accepted");
      assert.deepEqual((yield* usage(path, headers)).used, { submissions: 1, classifications: 1 });
    }),
  25_000,
);
