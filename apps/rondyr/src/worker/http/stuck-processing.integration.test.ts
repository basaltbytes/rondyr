import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { makeRpcStub, type RpcCallError } from "@alchemy.run/cloudflare/Workers/Rpc";
import { assert, beforeAll, it, vi } from "@effect/vitest";
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";

import { testOrigin as origin } from "../../../tests/integration/auth-fixture.ts";
import {
  call,
  createInbox,
  json,
  signIn,
} from "../../../tests/integration/organization-fixture.ts";
import { secretCipherLive } from "../adapters/crypto/secret-cipher.ts";
import { submissionIntakeLive } from "../adapters/database/intake.ts";
import { outboxLive } from "../adapters/database/outbox.ts";
import { classificationQueueLive } from "../adapters/queues/classification-queue.ts";
import { turnstileVerifierLive } from "../adapters/workers/siteverify.ts";
import { CreatedApiToken } from "../../domain/organizations/api-token.ts";
import { SubmissionDetail } from "../../domain/submissions/inbox.ts";
import { OperationsStatus, StuckSubmissions } from "../../domain/submissions/operations-status.ts";
import { SubmissionId } from "../../domain/submissions/submission.id.ts";
import { publishPendingSubmissions } from "../jobs/submission-outbox.ts";
import { SubmissionIntake } from "../ports/intake.ts";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

const readStuck = Schema.decodeUnknownEffect(StuckSubmissions);
const readStuckText = Schema.decodeUnknownEffect(Schema.fromJsonString(StuckSubmissions));
const readStatus = Schema.decodeUnknownEffect(OperationsStatus);
const readDetail = Schema.decodeUnknownEffect(SubmissionDetail);
const readCreated = Schema.decodeUnknownEffect(CreatedApiToken);
const readAccepted = Schema.decodeUnknownEffect(Schema.Struct({ "submission-id": SubmissionId }));
const readEvents = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ event: Schema.Struct({ _tag: Schema.String }) })),
);

/** The tags of the events in the submission's stream, in order. */
const recordedEvents = (id: SubmissionId) => {
  const stub = env["Submissions.SubmissionAggregate"].getByName(id);
  const history = makeRpcStub<{ after: (seq: number) => Effect.Effect<unknown, RpcCallError> }>(
    stub,
  );
  return history.after(0).pipe(
    Effect.flatMap(readEvents),
    Effect.map((entries) => entries.map(({ event }) => event._tag)),
  );
};

const adapters = Layer.mergeAll(
  submissionIntakeLive.pipe(
    Layer.provide(
      turnstileVerifierLive.pipe(Layer.provide([secretCipherLive, FetchHttpClient.layer])),
    ),
  ),
  outboxLive,
  classificationQueueLive,
);

const stuckPath = (organizationId: string) =>
  `/api/organizations/${organizationId}/stuck-submissions`;

const inboxRow = (submissionId: SubmissionId) =>
  env.DB.prepare("SELECT status, reason FROM submission_inbox WHERE submission_id = ?")
    .bind(submissionId)
    .first();

const waitForInbox = (
  submissionId: SubmissionId,
  expected: { readonly status: string; readonly reason: string | null },
) =>
  Effect.promise(() =>
    vi.waitFor(
      () =>
        inboxRow(submissionId).then((row) => {
          assert.deepEqual(row, expected);
        }),
      { timeout: 15_000, interval: 100 },
    ),
  );

/**
 * Store a submission without publishing it, then let the Cron find it after
 * twelve publications without a hand-off, so that it marks it stuck.
 */
const stuckSubmission = Effect.fnUntraced(function* (
  publicId: string,
  fields: Record<string, string>,
) {
  const services = yield* Layer.build(adapters);
  const { submissionId } = yield* Context.get(services, SubmissionIntake).receive(
    publicId,
    fields,
    Option.none(),
  );
  yield* Effect.promise(() =>
    env.DB.prepare(
      "UPDATE outbox_events SET publication_count = 12, published_at = 1, lease_until = 0 WHERE submission_id = ?",
    )
      .bind(submissionId)
      .run(),
  );
  yield* publishPendingSubmissions().pipe(Effect.provideContext(services));
  const stuckAt = yield* Effect.promise(() =>
    env.DB.prepare("SELECT stuck_at FROM outbox_events WHERE submission_id = ?")
      .bind(submissionId)
      .first("stuck_at"),
  );
  assert.isNumber(stuckAt);
  return submissionId;
});

/** The classifications that the organization used today. */
const classificationsUsed = (organizationId: string) =>
  Effect.promise(() =>
    env.DB.prepare(
      "SELECT classifications FROM organization_daily_usage WHERE organization_id = ? AND day = date('now')",
    )
      .bind(organizationId)
      .first<number>("classifications"),
  );

const submit = Effect.fnUntraced(function* (publicId: string, fields: Schema.Json) {
  const response = yield* call("POST", `/f/${publicId}`, fields);
  assert.strictEqual(response.status, 202);
  const { "submission-id": submissionId } = yield* json(response).pipe(
    Effect.flatMap(readAccepted),
  );
  return submissionId;
});

const tokenRequest = (method: string, path: string, token: Redacted.Redacted<string>) =>
  Effect.promise(() =>
    env.TEST_WORKER.fetch(new URL(path, origin), {
      method,
      headers: { authorization: `Bearer ${Redacted.value(token)}` },
    }),
  );

it.live(
  "lists a stuck submission without its content, retries it by hand, then classifies it",
  () =>
    Effect.gen(function* () {
      const { cookie } = yield* signIn;
      const inbox = yield* createInbox("Stuck studio", { cookie });
      const form = inbox.forms[0];
      if (form === undefined) return assert.fail("The new inbox should have a form");
      const marker = "stuck-private-message-5f0c2e";
      const submissionId = yield* stuckSubmission(form.publicId, {
        message: marker,
        "fixture-verdict": "accept",
      });

      const status = yield* call("GET", "/api/operations", undefined, { cookie }).pipe(
        Effect.flatMap(json),
        Effect.flatMap(readStatus),
      );
      const studio = status.organizations.find(({ id }) => id === inbox.id);
      assert.deepEqual(studio?.outbox, { count: 0, oldestAgeMs: null, stuck: 1 });

      const listed = yield* call("GET", stuckPath(inbox.id), undefined, { cookie });
      assert.strictEqual(listed.status, 200);
      assert.strictEqual(listed.headers.get("cache-control"), "no-store");
      const body = yield* Effect.promise(() => listed.text());
      assert.notInclude(body, marker);
      const stuck = yield* readStuckText(body);
      assert.strictEqual(stuck.count, 1);
      assert.deepInclude(stuck.submissions[0], {
        submissionId,
        formPublicId: form.publicId,
        formName: form.name,
      });

      const retried = yield* call(
        "POST",
        `${stuckPath(inbox.id)}/${submissionId}/retry`,
        undefined,
        {
          cookie,
        },
      );
      assert.strictEqual(retried.status, 200);
      const after = yield* json(retried).pipe(Effect.flatMap(readStuck));
      assert.deepEqual(after, { count: 0, submissions: [] });
      const reset = yield* Effect.promise(() =>
        env.DB.prepare(
          "SELECT stuck_at, publication_count FROM outbox_events WHERE submission_id = ?",
        )
          .bind(submissionId)
          .first(),
      );
      assert.deepEqual(reset, { stuck_at: null, publication_count: 1 });
      yield* waitForInbox(submissionId, { status: "accepted", reason: null });

      // The event is handed off: there is nothing left to retry.
      const again = yield* call("POST", `${stuckPath(inbox.id)}/${submissionId}/retry`, undefined, {
        cookie,
      });
      assert.strictEqual(again.status, 409);
      const unknown = yield* call(
        "POST",
        `${stuckPath(inbox.id)}/0b6f6a3e-9d0e-4c43-8e57-3f1d4b2c9a10/retry`,
        undefined,
        { cookie },
      );
      assert.strictEqual(unknown.status, 404);
    }),
  45_000,
);

it.live(
  "reclassifies a message quarantined after a classifier error, and only that one",
  () =>
    Effect.gen(function* () {
      const { cookie } = yield* signIn;
      const inbox = yield* createInbox("Reclassification studio", { cookie }, "Pottery classes");
      const form = inbox.forms[0];
      if (form === undefined) return assert.fail("The new inbox should have a form");
      const decision = (submissionId: SubmissionId, name: string) =>
        call(
          "POST",
          `/api/organizations/${inbox.id}/submissions/${submissionId}/${name}`,
          undefined,
          { cookie },
        );

      // The fake Workers AI fails the first call for this message, then accepts it.
      const submissionId = yield* submit(form.publicId, {
        message: "Is there room in the Saturday class? Reference reclassify-2b91.",
        "fixture-verdict": "accept-after-error",
      });
      yield* waitForInbox(submissionId, { status: "quarantined", reason: "classification-error" });
      const usedAtIntake = yield* classificationsUsed(inbox.id);

      const reclassified = yield* decision(submissionId, "reclassify");
      assert.strictEqual(reclassified.status, 200);
      // The response waits for the request; the new run may already have accepted it.
      const detail = yield* json(reclassified).pipe(Effect.flatMap(readDetail));
      assert.include(["classifying", "accepted"], detail.status);
      assert.isNull(detail.reason);
      yield* waitForInbox(submissionId, { status: "accepted", reason: null });
      const events = yield* recordedEvents(submissionId);
      assert.deepEqual(events, [
        "ClassificationRequested",
        "SubmissionQuarantined",
        "ReclassificationRequested",
        "SubmissionAccepted",
      ]);

      // The run took exactly one slot, beside the one of intake.
      const afterRun = yield* classificationsUsed(inbox.id);
      assert.strictEqual(afterRun, (usedAtIntake ?? 0) + 1);

      // Accepted: no decision applies any more, and the refusal gives its slot back.
      const late = yield* decision(submissionId, "reclassify");
      assert.strictEqual(late.status, 409);
      const afterLate = yield* classificationsUsed(inbox.id);
      assert.strictEqual(afterLate, afterRun);

      // A quarantine for another reason is the classifier's or intake's answer.
      const solicitation = yield* submit(form.publicId, {
        message: "We sell pottery wheels. Reference reclassify-7c04.",
        "fixture-verdict": "solicitation",
      });
      yield* waitForInbox(solicitation, { status: "quarantined", reason: "solicitation" });
      const beforeRefusal = yield* classificationsUsed(inbox.id);
      const refused = yield* decision(solicitation, "reclassify");
      assert.strictEqual(refused.status, 409);
      const unchanged = yield* Effect.promise(() => inboxRow(solicitation));
      assert.deepEqual(unchanged, { status: "quarantined", reason: "solicitation" });
      // The aggregate refused the request: its slot is given back.
      const afterRefusal = yield* classificationsUsed(inbox.id);
      assert.strictEqual(afterRefusal, beforeRefusal);
    }),
  45_000,
);

it.live(
  "keeps stuck submissions and reclassification within the organizations of the account",
  () =>
    Effect.gen(function* () {
      const { cookie } = yield* signIn;
      const inbox = yield* createInbox("Isolated studio", { cookie });
      const form = inbox.forms[0];
      if (form === undefined) return assert.fail("The new inbox should have a form");
      yield* Effect.promise(() =>
        env.DB.batch([
          env.DB.prepare("INSERT INTO organizations (id, name) VALUES ('elsewhere', 'Elsewhere')"),
          env.DB.prepare(
            "INSERT INTO forms (id, organization_id, public_id, name) VALUES ('elsewhere-form', 'elsewhere', 'elsewhere-public', 'Elsewhere')",
          ),
        ]),
      );
      const foreign = yield* stuckSubmission("elsewhere-public", { message: "Elsewhere" });
      const own = yield* stuckSubmission(form.publicId, { message: "Here" });

      const foreignList = yield* call("GET", stuckPath("elsewhere"), undefined, { cookie });
      assert.strictEqual(foreignList.status, 404);
      for (const organizationId of ["elsewhere", inbox.id]) {
        const response = yield* call(
          "POST",
          `${stuckPath(organizationId)}/${foreign}/retry`,
          undefined,
          { cookie },
        );
        assert.strictEqual(response.status, 404);
      }
      const foreignReclassify = yield* call(
        "POST",
        `/api/organizations/elsewhere/submissions/${foreign}/reclassify`,
        undefined,
        { cookie },
      );
      assert.strictEqual(foreignReclassify.status, 404);
      const stillStuck = yield* Effect.promise(() =>
        env.DB.prepare("SELECT stuck_at FROM outbox_events WHERE submission_id = ?")
          .bind(foreign)
          .first("stuck_at"),
      );
      assert.isNumber(stillStuck);

      const status = yield* call("GET", "/api/operations", undefined, { cookie }).pipe(
        Effect.flatMap(json),
        Effect.flatMap(readStatus),
      );
      assert.isFalse(status.organizations.some(({ id }) => id === "elsewhere"));
      const ownList = yield* call("GET", stuckPath(inbox.id), undefined, { cookie }).pipe(
        Effect.flatMap(json),
        Effect.flatMap(readStuck),
      );
      assert.deepEqual(
        ownList.submissions.map(({ submissionId }) => submissionId),
        [own],
      );

      // An API token reads and reviews its inbox, and nothing else.
      const created = yield* call(
        "POST",
        `/api/organizations/${inbox.id}/api-tokens`,
        { name: "Site inbox" },
        { cookie },
      );
      assert.strictEqual(created.status, 201);
      const { token } = yield* json(created).pipe(Effect.flatMap(readCreated));
      const tokenList = yield* tokenRequest("GET", stuckPath(inbox.id), token);
      assert.strictEqual(tokenList.status, 403);
      const tokenRetry = yield* tokenRequest("POST", `${stuckPath(inbox.id)}/${own}/retry`, token);
      assert.strictEqual(tokenRetry.status, 403);
      const tokenReclassify = yield* tokenRequest(
        "POST",
        `/api/organizations/${inbox.id}/submissions/${own}/reclassify`,
        token,
      );
      assert.strictEqual(tokenReclassify.status, 403);
    }),
  45_000,
);

it.live(
  "publishes a stuck submission once when two retries arrive together",
  () =>
    Effect.gen(function* () {
      const { cookie } = yield* signIn;
      const inbox = yield* createInbox("Double retry studio", { cookie });
      const form = inbox.forms[0];
      if (form === undefined) return assert.fail("The new inbox should have a form");
      const submissionId = yield* stuckSubmission(form.publicId, {
        message: "Retried twice at once",
        "fixture-verdict": "accept",
      });

      const retry = call("POST", `${stuckPath(inbox.id)}/${submissionId}/retry`, undefined, {
        cookie,
      });
      const responses = yield* Effect.all([retry, retry], { concurrency: 2 });
      assert.deepEqual(
        responses.map(({ status }) => status).toSorted((a, b) => a - b),
        [200, 409],
      );
      yield* waitForInbox(submissionId, { status: "accepted", reason: null });
      const count = yield* Effect.promise(() =>
        env.DB.prepare("SELECT publication_count FROM outbox_events WHERE submission_id = ?")
          .bind(submissionId)
          .first("publication_count"),
      );
      assert.strictEqual(count, 1);
    }),
  45_000,
);

it.live(
  "takes a classification slot for a reclassification, refuses one over the daily quota, and runs one for two clicks",
  () =>
    Effect.gen(function* () {
      const { cookie } = yield* signIn;
      const inbox = yield* createInbox("Quota studio", { cookie }, "Pottery classes");
      const form = inbox.forms[0];
      if (form === undefined) return assert.fail("The new inbox should have a form");
      const reclassify = (submissionId: SubmissionId) =>
        call(
          "POST",
          `/api/organizations/${inbox.id}/submissions/${submissionId}/reclassify`,
          undefined,
          { cookie },
        );
      const limitClassifications = (limit: number) =>
        Effect.promise(() =>
          env.DB.prepare("UPDATE organizations SET daily_classification_limit = ? WHERE id = ?")
            .bind(limit, inbox.id)
            .run(),
        );

      const submissionId = yield* submit(form.publicId, {
        message: "Is the Sunday class full? Reference reclassify-quota-41d2.",
        "fixture-verdict": "accept-after-error",
      });
      yield* waitForInbox(submissionId, { status: "quarantined", reason: "classification-error" });
      const usedAtIntake = yield* classificationsUsed(inbox.id);
      assert.strictEqual(usedAtIntake, 1);

      // The day's classifications are used up: the message stays in quarantine.
      yield* limitClassifications(1);
      const refused = yield* reclassify(submissionId);
      assert.strictEqual(refused.status, 429);
      assert.strictEqual(refused.headers.get("cache-control"), "no-store");
      const refusal = yield* json(refused);
      assert.deepEqual(refusal, { error: "classification-quota-reached" });
      const usedAfterRefusal = yield* classificationsUsed(inbox.id);
      assert.strictEqual(usedAfterRefusal, 1);
      const kept = yield* Effect.promise(() => inboxRow(submissionId));
      assert.deepEqual(kept, { status: "quarantined", reason: "classification-error" });
      const unchanged = yield* recordedEvents(submissionId);
      assert.deepEqual(unchanged, ["ClassificationRequested", "SubmissionQuarantined"]);

      // Two clicks at once start one run; the second gets 409. Each click takes a slot
      // before the aggregate decides, and the refused one gives it back.
      yield* limitClassifications(10);
      const responses = yield* Effect.all([reclassify(submissionId), reclassify(submissionId)], {
        concurrency: 2,
      });
      assert.deepEqual(
        responses.map(({ status }) => status).toSorted((a, b) => a - b),
        [200, 409],
      );
      yield* waitForInbox(submissionId, { status: "accepted", reason: null });
      const events = yield* recordedEvents(submissionId);
      assert.deepEqual(events, [
        "ClassificationRequested",
        "SubmissionQuarantined",
        "ReclassificationRequested",
        "SubmissionAccepted",
      ]);
      const used = yield* classificationsUsed(inbox.id);
      assert.strictEqual(used, 2);
    }),
  45_000,
);
