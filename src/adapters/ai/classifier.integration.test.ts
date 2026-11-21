import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, beforeAll, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";

import { Classifier } from "../../domain/submissions/classifier.external.ts";
import { OrganizationId } from "../../domain/submissions/submission.id.ts";
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
