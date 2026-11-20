import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, beforeAll, it, vi } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";

import { testOrigin as origin, testSetupToken } from "../../tests/integration/auth-fixture.ts";
import { outboxLive } from "../adapters/database/outbox.ts";
import { classificationQueueLive } from "../adapters/queues/classification-queue.ts";
import { InboxOrganizationWithForms } from "../domain/submissions/inbox-setup.ts";
import { InboxPage, SubmissionDetail } from "../domain/submissions/inbox.ts";
import { SubmissionId } from "../domain/submissions/submission.id.ts";
import { publishPendingSubmissions } from "../jobs/submission-outbox.ts";

const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const readAccepted = Schema.decodeUnknownEffect(Schema.Struct({ "submission-id": SubmissionId }));
const readInboxes = Schema.decodeUnknownEffect(Schema.Array(InboxOrganizationWithForms));
const readPage = Schema.decodeUnknownEffect(InboxPage);
const readSubmission = Schema.decodeUnknownEffect(SubmissionDetail);
const contact = { email: "customer@example.test", message: "Is there room in the pottery class?" };
const outboxLayer = Layer.mergeAll(outboxLive, classificationQueueLive);

function request(path: string, init?: RequestInit) {
  return Effect.promise(() => env.TEST_WORKER.fetch(new URL(path, origin), init));
}

const post = Effect.fnUntraced(function* (path: string, data: Schema.Json, extra?: HeadersInit) {
  const body = yield* encode(data);
  const headers = new Headers(extra);
  headers.set("content-type", "application/json");
  headers.set("origin", origin);
  return yield* request(path, { method: "POST", headers, body });
});

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

it.live("keeps intake atomic when the outbox write fails", () =>
  Effect.gen(function* () {
    yield* Effect.promise(() =>
      env.DB.batch([
        env.DB.prepare("INSERT INTO organizations (id, name) VALUES ('atomic-org', 'Atomic')"),
        env.DB.prepare(
          "INSERT INTO forms (id, organization_id, public_id, name) VALUES ('atomic-form', 'atomic-org', 'atomic', 'Atomic')",
        ),
        env.DB.prepare(`
          CREATE TRIGGER reject_outbox BEFORE INSERT ON outbox_events
          BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END
        `),
      ]),
    );
    const response = yield* post("/f/atomic", contact);
    assert.strictEqual(response.status, 503);
    const count = yield* Effect.promise(() =>
      env.DB.prepare("SELECT COUNT(*) FROM submissions WHERE form_id = 'atomic-form'").first(
        "COUNT(*)",
      ),
    );
    assert.strictEqual(count, 0);
  }).pipe(
    Effect.ensuring(
      Effect.promise(() => env.DB.prepare("DROP TRIGGER IF EXISTS reject_outbox").run()),
    ),
  ),
);

it.live(
  "receives a public form, recovers its outbox, and serializes tenant-scoped review",
  () =>
    Effect.gen(function* () {
      const credentials = { email: "potter@example.test", password: "review-inbox-test-password" };
      const setup = yield* post(
        "/api/setup",
        { name: "Potter", ...credentials },
        { authorization: `Bearer ${testSetupToken}` },
      );
      assert.strictEqual(setup.status, 201);

      const signIn = yield* post("/api/auth/sign-in/email", credentials);
      assert.strictEqual(signIn.status, 200);
      const cookie = signIn.headers
        .getSetCookie()
        .map((value) => value.split(";", 1)[0])
        .join("; ");
      assert.isNotEmpty(cookie);
      const headers = { cookie, origin };

      const created = yield* post(
        "/api/organizations",
        {
          organizationName: "Pottery studio",
          formName: "Classes",
          businessContext: "Pottery workshops",
        },
        headers,
      );
      assert.strictEqual(created.status, 201);
      const inboxesResponse = yield* request("/api/organizations", { headers });
      const inboxesRaw = yield* Effect.promise(() => inboxesResponse.json());
      const [inbox] = yield* readInboxes(inboxesRaw);
      const form = inbox?.forms[0];
      if (inbox === undefined || form === undefined)
        return assert.fail("The new inbox should have a form");

      const accepted = yield* request(`/f/${form.publicId}`, {
        method: "POST",
        body: new URLSearchParams(contact),
      });
      assert.strictEqual(accepted.status, 202);
      const rawSubmissionId = yield* Effect.promise(() => accepted.json());
      const { "submission-id": submissionId } = yield* readAccepted(rawSubmissionId);
      const persisted = yield* Effect.promise(() =>
        env.DB.prepare(`
        SELECT f.public_id, e.handed_off_at FROM submissions s
          JOIN outbox_events e ON e.submission_id = s.id JOIN forms f ON f.id = s.form_id
        WHERE s.id = ?
      `)
          .bind(submissionId)
          .first(),
      );
      assert.deepEqual(persisted, { public_id: form.publicId, handed_off_at: null });

      const listPath = `/api/organizations/${inbox.id}/submissions`;
      const path = `${listPath}/${submissionId}`;
      const unauthorized = yield* request(path);
      assert.strictEqual(unauthorized.status, 401);

      yield* Effect.promise(() =>
        env.DB.prepare("UPDATE outbox_events SET published_at = 1 WHERE submission_id = ?")
          .bind(submissionId)
          .run(),
      );
      const outbox = yield* Layer.build(outboxLayer);
      yield* publishPendingSubmissions().pipe(Effect.provideContext(outbox));
      yield* Effect.promise(() => env.CLASSIFICATION_QUEUE.send({ submissionId }));

      yield* Effect.promise(() =>
        vi.waitFor(
          () =>
            env.DB.prepare("SELECT status, version FROM submission_inbox WHERE submission_id = ?")
              .bind(submissionId)
              .first()
              .then((row) => {
                assert.deepEqual(row, { status: "quarantined", version: 2 });
              }),
          { timeout: 15_000, interval: 100 },
        ),
      );
      const handedOff = yield* Effect.promise(() =>
        env.DB.prepare("SELECT handed_off_at FROM outbox_events WHERE submission_id = ?")
          .bind(submissionId)
          .first("handed_off_at"),
      );
      assert.isNumber(handedOff);
      const classified = yield* request(path, { headers });
      const rawDetail = yield* Effect.promise(() => classified.json());
      const detail = yield* readSubmission(rawDetail);
      assert.strictEqual(detail.reason, "classification-error");
      assert.deepEqual(detail.fields, contact);

      const invalid = yield* request(`${listPath}?after=invalid`, { headers });
      assert.strictEqual(invalid.status, 400);
      const quarantined = yield* request(`${listPath}?status=quarantined`, { headers });
      const rawList = yield* Effect.promise(() => quarantined.json());
      const page = yield* readPage(rawList);
      assert.deepEqual(
        page.entries.map((entry) => entry.submissionId),
        [submissionId],
      );

      yield* Effect.promise(() =>
        env.DB.batch([
          env.DB.prepare("INSERT INTO organizations (id, name) VALUES ('other-org', 'Other')"),
          env.DB.prepare(
            "INSERT INTO forms (id, organization_id, public_id, name) VALUES ('other-form', 'other-org', 'other', 'Other')",
          ),
        ]),
      );
      const other = yield* post("/f/other", contact);
      assert.strictEqual(other.status, 202);
      const otherBody = yield* Effect.promise(() => other.json());
      const { "submission-id": outsiderId } = yield* readAccepted(otherBody);
      const foreignList = yield* request("/api/organizations/other-org/submissions", { headers });
      const foreignDetail = yield* request(`${listPath}/${outsiderId}`, { headers });
      const foreignReview = yield* request(
        `/api/organizations/other-org/submissions/${outsiderId}/approve`,
        { method: "POST", headers },
      );
      assert.deepEqual(
        [foreignList.status, foreignDetail.status, foreignReview.status],
        [404, 404, 404],
      );

      const results = yield* Effect.all(
        [
          request(`${path}/approve`, { method: "POST", headers }),
          request(`${path}/dismiss`, { method: "POST", headers }),
        ],
        { concurrency: "unbounded" },
      );
      assert.deepEqual(results.map(({ status }) => status).toSorted(), [200, 409]);
      const projection = yield* Effect.promise(() =>
        env.DB.prepare("SELECT version FROM submission_inbox WHERE submission_id = ?")
          .bind(submissionId)
          .first("version"),
      );
      assert.strictEqual(projection, 3);
    }),
  30_000,
);
