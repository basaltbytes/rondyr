import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, beforeAll, it, vi } from "@effect/vitest";
import { Context, Effect, Layer, Schema } from "effect";

import { testOrigin } from "../../../tests/integration/auth-fixture.ts";
import { Classifier } from "../../domain/submissions/classifier.external.ts";
import { OrganizationId, SubmissionId } from "../../domain/submissions/submission.id.ts";
import { classificationPoliciesLive } from "../database/classification-policies.ts";
import { storedMessagesLive } from "../database/stored-messages.ts";
import { classifierLive } from "./classifier.ts";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

const classifier = Effect.map(
  Layer.build(
    classifierLive.pipe(
      Layer.provide(Layer.mergeAll(storedMessagesLive, classificationPoliciesLive)),
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
const configurations = [
  {
    name: "stage without a second classifier",
    worker: "TEST_WORKER",
    status: { status: "quarantined", reason: "ambiguous" },
    models: ["typesafe/jev"],
  },
  {
    name: "stage configured with the primary classifier twice",
    worker: "SAME_CLASSIFIER_WORKER",
    status: { status: "quarantined", reason: "ambiguous" },
    models: ["typesafe/jev"],
  },
  {
    name: "stage configured with a different second classifier",
    worker: "ESCALATION_WORKER",
    status: { status: "accepted", reason: null },
    models: ["typesafe/jev", "openai/decisions"],
  },
] as const;

for (const { name, worker, status, models } of configurations) {
  it.live(
    `records the classification and AI calls for a ${name}`,
    () =>
      Effect.gen(function* () {
        const id = `classifier-${worker.toLowerCase()}`;
        yield* Effect.promise(() =>
          env.DB.batch([
            env.DB.prepare("INSERT INTO organizations (id, name) VALUES (?, ?)").bind(id, name),
            env.DB.prepare(
              "INSERT INTO forms (id, organization_id, public_id, name) VALUES (?, ?, ?, ?)",
            ).bind(id, id, id, name),
            env.DB.prepare(
              "INSERT INTO organization_classification_policies (organization_id, policy) VALUES (?, ?)",
            ).bind(id, '{"escalation":true}'),
          ]),
        );
        const response = yield* Effect.promise(() =>
          env[worker].fetch(new URL(`/f/${id}`, testOrigin), {
            method: "POST",
            body: new URLSearchParams({ message: id, "fixture-verdict": "ambiguous-solicitation" }),
          }),
        );
        assert.strictEqual(response.status, 202);
        const body = yield* Effect.promise(() => response.json());
        const { "submission-id": submissionId } = yield* readAccepted(body);
        yield* Effect.promise(() =>
          vi.waitFor(
            () =>
              env.DB.prepare("SELECT status, reason FROM submission_inbox WHERE submission_id = ?")
                .bind(submissionId)
                .first()
                .then((row) => assert.deepEqual(row, status)),
            { timeout: 15_000, interval: 100 },
          ),
        );
        const calls = yield* Effect.promise(() =>
          env.WORKERS_AI_FIXTURE.fetch(`https://workers-ai.test/__models?message=${id}`).then(
            (modelCalls) => modelCalls.json(),
          ),
        );
        assert.deepEqual(calls, models);
      }),
    20_000,
  );
}
