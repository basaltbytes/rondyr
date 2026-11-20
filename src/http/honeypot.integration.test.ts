import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, beforeAll, it, vi } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { testOrigin as origin, testSetupToken } from "../../tests/integration/auth-fixture.ts";
import { ManagedForm } from "../domain/forms/form.ts";
import { InboxOrganizationWithForms } from "../domain/submissions/inbox-setup.ts";
import { SubmissionDetail } from "../domain/submissions/inbox.ts";
import { SubmissionId } from "../domain/submissions/submission.id.ts";

const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const readInboxes = Schema.decodeUnknownEffect(Schema.Array(InboxOrganizationWithForms));
const readForm = Schema.decodeUnknownEffect(ManagedForm);
const readAccepted = Schema.decodeUnknownEffect(
  Schema.Struct({ "submission-id": SubmissionId, status: Schema.Literal("received") }),
);
const readSubmission = Schema.decodeUnknownEffect(SubmissionDetail);
const readCalls = Schema.decodeUnknownEffect(
  Schema.Array(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
);
const StoredRow = Schema.Struct({
  fields: Schema.String,
  intake_reason: Schema.NullOr(Schema.String),
});
const readStored = Schema.decodeUnknownEffect(StoredRow);

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

function request(path: string, init?: RequestInit) {
  return Effect.promise(() => env.TEST_WORKER.fetch(new URL(path, origin), init));
}

/** A JSON request from the dashboard's origin. */
const call = Effect.fnUntraced(function* (
  method: string,
  path: string,
  data?: Schema.Json,
  extra?: HeadersInit,
) {
  const headers = new Headers(extra);
  headers.set("origin", origin);
  if (data === undefined) return yield* request(path, { method, headers });
  headers.set("content-type", "application/json");
  const body = yield* encode(data);
  return yield* request(path, { method, headers, body });
});

const json = (response: Response) => Effect.promise(() => response.json());

const credentials = { email: "honeypot@example.test", password: "honeypot-test-password" };

/** The cookie of the file's account. The first call creates the account. */
const signIn = Effect.gen(function* () {
  const setup = yield* call(
    "POST",
    "/api/setup",
    { name: "Honeypot", ...credentials },
    { authorization: `Bearer ${testSetupToken}` },
  );
  assert.oneOf(setup.status, [201, 404]);
  const session = yield* call("POST", "/api/auth/sign-in/email", credentials);
  assert.strictEqual(session.status, 200);
  const cookie = session.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  return { cookie, origin };
});

/** An organization of the account and its first form, with the honeypot field `field`. */
const createForm = Effect.fnUntraced(function* (
  headers: HeadersInit,
  organizationName: string,
  field: string | null,
) {
  const created = yield* call(
    "POST",
    "/api/organizations",
    { organizationName, formName: "Contact", businessContext: "Pottery workshops" },
    headers,
  );
  assert.strictEqual(created.status, 201);
  const inboxes = yield* request("/api/organizations", { headers }).pipe(
    Effect.flatMap(json),
    Effect.flatMap(readInboxes),
  );
  const inbox = inboxes.find(({ name }) => name === organizationName);
  const form = inbox?.forms[0];
  if (inbox === undefined || form === undefined) return assert.fail("Expected a form");
  const formPath = `/api/organizations/${inbox.id}/forms/${form.publicId}`;
  if (field !== null) {
    const set = yield* call("PUT", `${formPath}/honeypot`, { field }, headers);
    assert.strictEqual(set.status, 200);
    const updated = yield* json(set).pipe(Effect.flatMap(readForm));
    assert.strictEqual(updated.honeypotField, field.trim());
  }
  return { inboxId: inbox.id, publicId: form.publicId, formPath };
});

/** Post a JSON submission and return its ID. */
const submitJson = Effect.fnUntraced(function* (publicId: string, fields: Schema.Json) {
  const response = yield* call("POST", `/f/${publicId}`, fields);
  assert.strictEqual(response.status, 202);
  const { "submission-id": submissionId } = yield* json(response).pipe(
    Effect.flatMap(readAccepted),
  );
  return submissionId;
});

/** An HTML form post, as a browser sends it. */
const postHtml = (publicId: string, body: string) =>
  request(`/f/${publicId}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    },
    body,
  });

const stored = Effect.fnUntraced(function* (submissionId: SubmissionId) {
  const row = yield* Effect.promise(() =>
    env.DB.prepare("SELECT fields, intake_reason FROM submissions WHERE id = ?")
      .bind(submissionId)
      .first(),
  );
  return yield* readStored(row);
});

const storedCount = (publicId: string) =>
  Effect.promise(() =>
    env.DB.prepare(
      "SELECT COUNT(*) AS count FROM submissions s JOIN forms f ON f.id = s.form_id WHERE f.public_id = ?",
    )
      .bind(publicId)
      .first("count"),
  );

/** Wait until the inbox shows the submission with this status, version and reason. */
const inboxReaches = (
  submissionId: SubmissionId,
  expected: { status: string; version: number; reason: string | null },
) =>
  Effect.promise(() =>
    vi.waitFor(
      () =>
        env.DB.prepare(
          "SELECT status, version, reason FROM submission_inbox WHERE submission_id = ?",
        )
          .bind(submissionId)
          .first()
          .then((row) => {
            assert.deepEqual(row, expected);
          }),
      { timeout: 20_000, interval: 100 },
    ),
  );

/** The submission fields of every call that the Workers AI fixture received. */
const classifierCalls = Effect.promise(() =>
  env.WORKERS_AI_FIXTURE.fetch("https://workers-ai.test/__calls").then((response) =>
    response.json(),
  ),
).pipe(Effect.flatMap(readCalls));

const callsWith = (marker: string) =>
  Effect.map(classifierCalls, (calls) =>
    calls.filter((fields) => fields !== null && Object.values(fields).includes(marker)),
  );

it.live(
  "answers a filled honeypot like any submission and quarantines it without the classifier",
  () =>
    Effect.gen(function* () {
      const headers = yield* signIn;
      const { inboxId, publicId } = yield* createForm(headers, "Trap studio", " _hp ");
      yield* Effect.promise(() =>
        env.DB.prepare(`
          INSERT INTO notification_targets (id, organization_id, form_id, type, configuration, created_at)
          SELECT 'trap-webhook', organization_id, id, 'webhook', '{}', 0 FROM forms WHERE public_id = ?
        `)
          .bind(publicId)
          .run(),
      );

      // A browser gets the same page whether the honeypot field is empty or filled.
      const person = yield* postHtml(publicId, "email=visitor%40example.com&message=Hello&_hp=");
      const bot = yield* postHtml(
        publicId,
        "email=bot%40example.com&message=Cheap+watches&_hp=https%3A%2F%2Fspam.example",
      );
      const pages = yield* Effect.forEach([person, bot], (response) =>
        Effect.promise(() => response.text()).pipe(
          Effect.map((text) => ({
            status: response.status,
            type: response.headers.get("content-type"),
            cache: response.headers.get("cache-control"),
            cors: response.headers.get("access-control-allow-origin"),
            text,
          })),
        ),
      );
      assert.strictEqual(pages[0]?.status, 202);
      assert.deepEqual(pages[1], pages[0]);
      const count = yield* storedCount(publicId);
      assert.strictEqual(count, 2);

      // The fixture would accept this message if the classifier ever saw it.
      const marker = "honeypot-filled-probe";
      const fields = { message: marker, _hp: "Acme Ltd", "fixture-verdict": "accept" };
      const submissionId = yield* submitJson(publicId, fields);
      // One event: SubmissionQuarantined, without ClassificationRequested before it.
      yield* inboxReaches(submissionId, { status: "quarantined", version: 1, reason: "honeypot" });
      const row = yield* stored(submissionId);
      assert.strictEqual(row.intake_reason, "honeypot");
      // The filled field is kept, so that the reviewer sees what was sent.
      const storedFields = yield* decodeJson(row.fields);
      assert.deepEqual(storedFields, fields);
      const detail = yield* request(`/api/organizations/${inboxId}/submissions/${submissionId}`, {
        headers,
      }).pipe(Effect.flatMap(json), Effect.flatMap(readSubmission));
      assert.deepEqual([detail.status, detail.reason], ["quarantined", "honeypot"]);
      const classifiedBefore = yield* callsWith(marker);
      assert.deepEqual(classifiedBefore, []);

      // A duplicate queue message, as after a crash before the hand-off was recorded,
      // reaches the same decision: the submission keeps its single event.
      yield* Effect.promise(() =>
        env.DB.prepare("UPDATE outbox_events SET handed_off_at = NULL WHERE submission_id = ?")
          .bind(submissionId)
          .run(),
      );
      yield* Effect.promise(() => env.CLASSIFICATION_QUEUE.send({ submissionId }));
      yield* Effect.promise(() =>
        vi.waitFor(
          () =>
            env.DB.prepare("SELECT handed_off_at FROM outbox_events WHERE submission_id = ?")
              .bind(submissionId)
              .first("handed_off_at")
              .then((handedOffAt) => {
                assert.isNumber(handedOffAt);
              }),
          { timeout: 15_000, interval: 100 },
        ),
      );

      // A reviewer accepts it as any quarantined message. Its acceptance is the
      // second event, so the duplicate added none, and the deliveries follow.
      const approval = yield* request(
        `/api/organizations/${inboxId}/submissions/${submissionId}/approve`,
        { method: "POST", headers },
      );
      assert.strictEqual(approval.status, 200);
      yield* inboxReaches(submissionId, { status: "accepted", version: 2, reason: null });
      yield* Effect.promise(() =>
        vi.waitFor(
          () =>
            env.DB.prepare(
              "SELECT target_id, attempt_count FROM deliveries WHERE submission_id = ?",
            )
              .bind(submissionId)
              .all()
              .then(({ results }) => {
                assert.deepEqual(results, [{ target_id: "trap-webhook", attempt_count: 1 }]);
              }),
          { timeout: 20_000, interval: 100 },
        ),
      );
      const classifiedAfter = yield* callsWith(marker);
      assert.deepEqual(classifiedAfter, []);
    }),
  60_000,
);

it.live(
  "removes an empty honeypot field before storage and classification",
  () =>
    Effect.gen(function* () {
      const headers = yield* signIn;
      const { publicId } = yield* createForm(headers, "Empty trap studio", "_gotcha");

      const marker = "honeypot-empty-probe";
      const submissionId = yield* submitJson(publicId, {
        email: "visitor@example.com",
        _gotcha: "",
        message: marker,
        "fixture-verdict": "accept",
      });
      const row = yield* stored(submissionId);
      // The other fields keep their order.
      const kept = { email: "visitor@example.com", message: marker, "fixture-verdict": "accept" };
      const keptJson = yield* encode(kept);
      assert.strictEqual(row.fields, keptJson);
      assert.isNull(row.intake_reason);
      yield* inboxReaches(submissionId, { status: "accepted", version: 2, reason: null });
      const classified = yield* callsWith(marker);
      assert.deepEqual(classified, [kept]);

      // A form body whose only field is the empty honeypot field has no message.
      const empty = yield* Effect.all([
        postHtml(publicId, "_gotcha="),
        call("POST", `/f/${publicId}`, { _gotcha: "" }),
      ]);
      assert.deepEqual(
        empty.map(({ status }) => status),
        [400, 400],
      );
      const count = yield* storedCount(publicId);
      assert.strictEqual(count, 1);
    }),
  60_000,
);

it.live(
  "keeps the fields of a form without a honeypot field, and after the field is cleared",
  () =>
    Effect.gen(function* () {
      const headers = yield* signIn;
      const { publicId, formPath } = yield* createForm(headers, "Open studio", "_hp");
      const cleared = yield* call("DELETE", `${formPath}/honeypot`, undefined, headers).pipe(
        Effect.flatMap(json),
        Effect.flatMap(readForm),
      );
      assert.isNull(cleared.honeypotField);

      const marker = "honeypot-absent-probe";
      const fields = { _hp: "filled", empty: "", message: marker, "fixture-verdict": "accept" };
      const submissionId = yield* submitJson(publicId, fields);
      const row = yield* stored(submissionId);
      const fieldsJson = yield* encode(fields);
      assert.strictEqual(row.fields, fieldsJson);
      assert.isNull(row.intake_reason);
      yield* inboxReaches(submissionId, { status: "accepted", version: 2, reason: null });
      const classified = yield* callsWith(marker);
      assert.deepEqual(classified, [fields]);
    }),
  60_000,
);
