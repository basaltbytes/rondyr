import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, beforeAll, it, vi } from "@effect/vitest";
import { Context, Effect, Layer, Schema } from "effect";

import { testOrigin } from "../../../../tests/integration/auth-fixture.ts";
import { Classifier } from "../../../domain/submissions/classifier.external.ts";
import { OrganizationId, SubmissionId } from "../../../domain/submissions/submission.id.ts";
import { classificationPoliciesLive } from "../database/classification-policies.ts";
import { organizationQuotasLive } from "../database/organization-quotas.ts";
import { storedMessagesLive } from "../database/stored-messages.ts";
import { classifierLive } from "./classifier.ts";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

const classifier = Effect.map(
  Layer.build(
    classifierLive.pipe(
      Layer.provide(
        Layer.mergeAll(storedMessagesLive, classificationPoliciesLive, organizationQuotasLive),
      ),
    ),
  ),
  Context.get(Classifier),
);

it.live("does not retry the lookup of a stored policy that does not decode", () =>
  Effect.gen(function* () {
    yield* Effect.promise(() =>
      env.DB.batch([
        env.DB.prepare("INSERT INTO organizations (id, name) VALUES ('unreadable', 'Unreadable')"),
        env.DB.prepare(
          "INSERT INTO organization_classification_policies (organization_id, policy) VALUES ('unreadable', ?)",
        ).bind('{"offTopic":"ignore"}'),
      ]),
    );
    const { policy } = yield* classifier;

    const failure = yield* Effect.flip(
      policy({ organizationId: OrganizationId.make("unreadable") }),
    );

    assert.isFalse(failure.retryable);
  }),
);

const readAccepted = Schema.decodeUnknownEffect(Schema.Struct({ "submission-id": SubmissionId }));
const readUsage = Schema.decodeUnknownEffect(
  Schema.Struct({
    day: Schema.String,
    today: Schema.String,
    submissions: Schema.Int,
    classifications: Schema.Int,
  }),
);
type EscalationWorker = "TEST_WORKER" | "SAME_CLASSIFIER_WORKER" | "ESCALATION_WORKER";

/** An organization with one form, escalation enabled and a daily classification limit. */
const createOrganization = (id: string, classificationLimit: number) =>
  Effect.promise(() =>
    env.DB.batch([
      env.DB.prepare(
        "INSERT INTO organizations (id, name, daily_classification_limit) VALUES (?1, ?1, ?2)",
      ).bind(id, classificationLimit),
      env.DB.prepare(
        "INSERT INTO forms (id, organization_id, public_id, name) VALUES (?1, ?1, ?1, ?1)",
      ).bind(id),
      env.DB.prepare(
        "INSERT INTO organization_classification_policies (organization_id, policy) VALUES (?, ?)",
      ).bind(id, '{"escalation":true}'),
    ]),
  );

/** Send a message whose text is `message` to the organization's form, and return its ID. */
const submit = Effect.fnUntraced(function* (
  worker: EscalationWorker,
  formId: string,
  message: string,
  verdict: string,
) {
  const response = yield* Effect.promise(() =>
    env[worker].fetch(new URL(`/f/${formId}`, testOrigin), {
      method: "POST",
      body: new URLSearchParams({ message, "fixture-verdict": verdict }),
    }),
  );
  assert.strictEqual(response.status, 202);
  const body = yield* Effect.promise(() => response.json());
  const { "submission-id": submissionId } = yield* readAccepted(body);
  return submissionId;
});

const inboxStatus = (submissionId: string) =>
  env.DB.prepare("SELECT status, reason FROM submission_inbox WHERE submission_id = ?")
    .bind(submissionId)
    .first();

const modelCalls = (message: string) =>
  Effect.promise(() =>
    env.WORKERS_AI_FIXTURE.fetch(`https://workers-ai.test/__models?message=${message}`).then(
      (response) => response.json(),
    ),
  );

const usage = (organizationId: string) =>
  Effect.promise(() =>
    env.DB.prepare(
      `SELECT day, date('now') AS today, submissions, classifications
       FROM organization_daily_usage WHERE organization_id = ?`,
    )
      .bind(organizationId)
      .first(),
  ).pipe(Effect.flatMap(readUsage));

// The second model clears the spam doubt of both verdicts. Jev also finds a sales
// pitch in `ambiguous-solicitation`, and that rule still applies. Intake counts
// one classification for each message, and an escalation reserves one more.
const configurations = [
  {
    id: "classifier-no-second-classifier",
    name: "an ambiguous message on a stage without a second classifier",
    worker: "TEST_WORKER",
    verdict: "ambiguous",
    limit: 1000,
    status: { status: "quarantined", reason: "ambiguous" },
    models: ["typesafe/jev"],
    classifications: 1,
  },
  {
    id: "classifier-same-classifier",
    name: "an ambiguous message on a stage configured with the primary classifier twice",
    worker: "SAME_CLASSIFIER_WORKER",
    verdict: "ambiguous",
    limit: 1000,
    status: { status: "quarantined", reason: "ambiguous" },
    models: ["typesafe/jev"],
    classifications: 1,
  },
  {
    id: "classifier-second-classifier",
    name: "an ambiguous message on a stage configured with a different second classifier",
    worker: "ESCALATION_WORKER",
    verdict: "ambiguous",
    limit: 1000,
    status: { status: "accepted", reason: null },
    models: ["typesafe/jev", "openai/decisions"],
    classifications: 2,
  },
  {
    id: "classifier-second-classifier-sales-pitch",
    name: "an ambiguous sales pitch on a stage configured with a different second classifier",
    worker: "ESCALATION_WORKER",
    verdict: "ambiguous-solicitation",
    limit: 1000,
    status: { status: "quarantined", reason: "solicitation" },
    models: ["typesafe/jev", "openai/decisions"],
    classifications: 2,
  },
  {
    id: "classifier-second-classifier-at-limit",
    name: "an ambiguous message that reaches the organization's daily classification limit",
    worker: "ESCALATION_WORKER",
    verdict: "ambiguous",
    limit: 1,
    status: { status: "quarantined", reason: "ambiguous" },
    models: ["typesafe/jev"],
    classifications: 1,
  },
] as const;

for (const {
  id,
  name,
  worker,
  verdict,
  limit,
  status,
  models,
  classifications,
} of configurations) {
  it.live(
    `records the classification, AI calls and daily usage for ${name}`,
    () =>
      Effect.gen(function* () {
        yield* createOrganization(id, limit);
        const submissionId = yield* submit(worker, id, id, verdict);
        yield* Effect.promise(() =>
          vi.waitFor(() => inboxStatus(submissionId).then((row) => assert.deepEqual(row, status)), {
            timeout: 15_000,
            interval: 100,
          }),
        );
        const calls = yield* modelCalls(id);
        assert.deepEqual(calls, models);
        const counted = yield* usage(id);
        assert.strictEqual(counted.classifications, classifications);
        assert.strictEqual(counted.day, counted.today);
      }),
    20_000,
  );
}

it.live(
  "gives the last classification of the day to one of two escalations",
  () =>
    Effect.gen(function* () {
      const id = "classifier-escalation-race";
      // Both messages pass intake, which leaves one classification for the escalations.
      yield* createOrganization(id, 3);
      const messages = [`${id}-first`, `${id}-second`];
      const submissionIds = yield* Effect.forEach(
        messages,
        (message) => submit("ESCALATION_WORKER", id, message, "ambiguous"),
        { concurrency: "unbounded" },
      );
      yield* Effect.promise(() =>
        vi.waitFor(
          () =>
            Promise.all(submissionIds.map(inboxStatus)).then((rows) =>
              assert.sameDeepMembers(rows, [
                { status: "accepted", reason: null },
                { status: "quarantined", reason: "ambiguous" },
              ]),
            ),
          { timeout: 15_000, interval: 100 },
        ),
      );
      const calls = (yield* Effect.forEach(messages, modelCalls)).flat();
      assert.sameMembers(calls, ["typesafe/jev", "typesafe/jev", "openai/decisions"]);
      assert.strictEqual((yield* usage(id)).classifications, 3);
    }),
  20_000,
);

it.live("reserves classifications atomically up to the limit and starts a new day at zero", () =>
  Effect.gen(function* () {
    const id = "classifier-reservations";
    yield* createOrganization(id, 2);
    // A counter row left from another day, already at the limit.
    yield* Effect.promise(() =>
      env.DB.prepare(
        "INSERT INTO organization_daily_usage (organization_id, day, submissions, classifications) VALUES (?, '2000-01-01', 5, 2)",
      )
        .bind(id)
        .run(),
    );
    const { reserveEscalation } = yield* classifier;
    const organizationId = OrganizationId.make(id);
    const outcomes = yield* Effect.forEach([1, 2, 3], () => reserveEscalation({ organizationId }), {
      concurrency: "unbounded",
    });
    assert.sameMembers(outcomes, ["reserved", "reserved", "limit-reached"]);
    const counted = yield* usage(id);
    // The new day starts at zero: the two reservations are its only classifications.
    assert.deepEqual(counted, {
      day: counted.today,
      today: counted.today,
      submissions: 0,
      classifications: 2,
    });
    const missing = yield* reserveEscalation({
      organizationId: OrganizationId.make("no-such-org"),
    });
    assert.strictEqual(missing, "limit-reached");
  }),
);
