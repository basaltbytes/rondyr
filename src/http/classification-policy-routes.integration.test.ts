import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, beforeAll, it, vi } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { testOrigin } from "../../tests/integration/auth-fixture.ts";
import { call, createInbox, json, signIn } from "../../tests/integration/organization-fixture.ts";
import {
  OrganizationClassificationPolicy,
  OrganizationClassificationSettings,
} from "../domain/organizations/organization-classification-policy.ts";
import { defaultClassificationPolicies } from "../domain/submissions/classification-policy.ts";
import { InboxPage } from "../domain/submissions/inbox.ts";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

const policyPath = (id: string) => `/api/organizations/${id}/classification-policy`;
const readSettings = Schema.decodeUnknownEffect(OrganizationClassificationSettings);
const readPage = Schema.decodeUnknownPromise(InboxPage);
const defaultPolicy = defaultClassificationPolicies.jev;

it.live("validates, persists and resets overrides with organization-scoped permissions", () =>
  Effect.gen(function* () {
    const headers = yield* signIn;
    const inbox = yield* createInbox("Policy settings", headers);
    const path = policyPath(inbox.id);
    const get = () =>
      call("GET", path, undefined, headers).pipe(
        Effect.flatMap(json),
        Effect.flatMap(readSettings),
      );
    const put = (override: Schema.Json) => call("PUT", path, override, headers);
    assert.strictEqual((yield* call("GET", path)).status, 401);
    const initial = yield* get();
    assert.deepEqual(initial, {
      classifier: "jev",
      escalationClassifier: null,
      defaults: defaultPolicy,
      override: null,
    });

    const invalid = [
      {},
      { offTopic: "ignore" },
      { offTopic: "accept", organizationId: "another" },
      { thresholds: { ...defaultPolicy.thresholds, ambiguous: 0.8 } },
      { thresholds: { ...defaultPolicy.thresholds, solicitation: -0.01 } },
      { thresholds: { ...defaultPolicy.thresholds, lowRelevance: 1.01 } },
    ];
    for (const input of invalid) assert.strictEqual((yield* put(input)).status, 400);

    const override = {
      thresholds: { ...defaultPolicy.thresholds, probableSpam: 1, ambiguous: 1, solicitation: 0 },
    };
    assert.strictEqual((yield* put(override)).status, 204);
    const decoded = yield* Schema.decodeEffect(OrganizationClassificationPolicy)(override);
    assert.deepEqual((yield* get()).override, decoded);

    yield* Effect.promise(() =>
      env.DB.prepare(
        "INSERT INTO organizations (id, name) VALUES ('foreign-policy', 'Foreign')",
      ).run(),
    );
    const foreign = policyPath("foreign-policy");
    assert.strictEqual((yield* call("GET", foreign, undefined, headers)).status, 404);
    assert.strictEqual((yield* call("PUT", foreign, override, headers)).status, 404);
    assert.strictEqual((yield* call("DELETE", foreign, undefined, headers)).status, 404);

    assert.strictEqual((yield* call("DELETE", path, undefined, headers)).status, 204);
    assert.strictEqual((yield* call("DELETE", path, undefined, headers)).status, 204);
    assert.isNull((yield* get()).override);
  }),
);

it.live("says which second classifier the stage offers, and none when it repeats the first", () =>
  Effect.gen(function* () {
    const headers = yield* signIn;
    const inbox = yield* createInbox("Second classifier", headers);
    const stages = [
      { worker: env.TEST_WORKER, escalationClassifier: null },
      { worker: env.SAME_CLASSIFIER_WORKER, escalationClassifier: null },
      { worker: env.ESCALATION_WORKER, escalationClassifier: "openai" },
    ] as const;
    for (const { worker, escalationClassifier } of stages) {
      const settings = yield* call("GET", policyPath(inbox.id), undefined, headers, worker).pipe(
        Effect.flatMap(json),
        Effect.flatMap(readSettings),
      );
      assert.deepEqual(settings, {
        classifier: "jev",
        escalationClassifier,
        defaults: defaultPolicy,
        override: null,
      });
    }
  }),
);

it.live(
  "classifies with an organization's override and projects the off-topic label",
  () =>
    Effect.gen(function* () {
      const headers = yield* signIn;
      const context = "Ceramics classes. fixture-relevance: low";
      const configured = yield* createInbox("Accept off-topic", headers, context);
      const defaults = yield* createInbox("Review off-topic by default", headers, context);
      const saved = yield* call("PUT", policyPath(configured.id), { offTopic: "accept" }, headers);
      assert.strictEqual(saved.status, 204);

      const submit = Effect.fnUntraced(function* (
        inbox: typeof configured,
        message: string,
        verdict: string,
      ) {
        const form = inbox.forms[0];
        if (form === undefined) return assert.fail("Expected the organization to have a form");
        const received = yield* call("POST", `/f/${form.publicId}`, {
          message,
          "fixture-verdict": verdict,
        });
        assert.strictEqual(received.status, 202);
      });
      yield* submit(configured, "Lost keys outside the building", "accept");
      yield* submit(defaults, "Lost scarf outside the building", "accept");
      yield* submit(configured, "Sales pitch outside the organization's business", "solicitation");

      const checkInbox = (
        inbox: typeof configured,
        expected: readonly {
          readonly status: string;
          readonly reason: string | null;
          readonly label: string | null;
        }[],
      ) =>
        Effect.promise(() =>
          vi.waitFor(
            () =>
              env.TEST_WORKER.fetch(
                new URL(`/api/organizations/${inbox.id}/submissions`, testOrigin),
                { headers },
              )
                .then((response) => {
                  assert.strictEqual(response.status, 200);
                  return response.json();
                })
                .then(readPage)
                .then(({ entries }) =>
                  assert.sameDeepMembers(
                    entries.map(({ status, reason, label }) => ({ status, reason, label })),
                    [...expected],
                  ),
                ),
            { timeout: 15_000, interval: 100 },
          ),
        );

      yield* checkInbox(configured, [
        { status: "accepted", reason: null, label: "off-topic" },
        { status: "quarantined", reason: "solicitation", label: null },
      ]);
      yield* checkInbox(defaults, [
        { status: "quarantined", reason: "low-relevance", label: null },
      ]);
    }),
  30_000,
);
