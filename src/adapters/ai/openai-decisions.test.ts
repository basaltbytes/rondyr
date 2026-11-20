import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import { OrganizationDomain } from "../../domain/organizations/organization-domain.ts";
import { classifierInput } from "../../domain/submissions/classifier-input.ts";
import { scoreWithOpenAi } from "./openai-decisions.ts";

const fields = { message: "Do you offer pottery classes?" };
const counts = { prior_same_sender: 2, prior_same_content: 1 };
const withoutContext = classifierInput(fields, "", counts);
const decision = {
  model: "gpt-6-luna",
  answers: [
    { type: "predicate", name: "relevance", probability: 0.9 },
    { type: "predicate", name: "spam", probability: 0.03 },
  ],
};

it.effect("routes Decisions through the default gateway and reads answers by name", () =>
  Effect.gen(function* () {
    const scores = yield* scoreWithOpenAi(
      {
        run: (model, request, options) => {
          assert.strictEqual(model, "openai/decisions");
          assert.deepEqual(options.gateway, { id: "default", collectLog: false, skipCache: true });
          assert.include(
            request.input,
            '"submission_fields":{"message":"Do you offer pottery classes?"}',
          );
          assert.include(request.input, '"business_context":"Pottery classes"');
          assert.include(
            request.input,
            '"facts":{"prior_same_sender":2,"prior_same_content":1,"url_or_html_outside_longest_field":false}',
          );
          assert.deepEqual(
            request.questions.map(({ name, type }) => ({ name, type })),
            [
              { name: "spam", type: "predicate" },
              { name: "relevance", type: "predicate" },
            ],
          );
          return Promise.resolve(decision);
        },
      },
      classifierInput(fields, "Pottery classes", counts),
    );

    assert.deepEqual(scores, { model: "gpt-6-luna", spam: 0.03, relevance: 0.9 });
  }),
);

it.effect("omits relevance without context and unwraps a completed Gateway response", () =>
  Effect.gen(function* () {
    const scores = yield* scoreWithOpenAi(
      {
        run: (_model, request) => {
          assert.deepEqual(
            request.questions.map(({ name }) => name),
            ["spam"],
          );
          return Promise.resolve({
            state: "Completed",
            result: {
              model: "gpt-6-luna",
              answers: [{ type: "predicate", name: "spam", probability: 0.03 }],
            },
          });
        },
      },
      withoutContext,
    );

    assert.deepEqual(scores, { model: "gpt-6-luna", spam: 0.03 });
  }),
);

it.effect("sends Decisions a same-domain fact without the matching email address", () =>
  Effect.gen(function* () {
    const scores = yield* scoreWithOpenAi(
      {
        run: (_model, request) => {
          assert.include(request.input, '"sender_matches_organization_domain":true');
          assert.notInclude(request.input, "studio.example");
          assert.include(
            request.questions.find(({ name }) => name === "spam")?.instructions,
            "sender_matches_organization_domain",
          );
          return Promise.resolve(decision);
        },
      },
      classifierInput({ ...fields, email: "team@sub.studio.example" }, "Pottery classes", counts, [
        OrganizationDomain.make("studio.example"),
      ]),
    );
    assert.strictEqual(scores.spam, 0.03);
  }),
);

it.effect("omits the domain fact and its instruction for an address outside the domains", () =>
  Effect.gen(function* () {
    const scores = yield* scoreWithOpenAi(
      {
        run: (_model, request) => {
          assert.notInclude(request.input, "sender_matches_organization_domain");
          assert.include(request.input, '"email":"team@notstudio.example"');
          for (const { instructions } of request.questions)
            assert.notInclude(instructions, "sender_matches_organization_domain");
          return Promise.resolve(decision);
        },
      },
      classifierInput({ ...fields, email: "team@notstudio.example" }, "Pottery classes", counts, [
        OrganizationDomain.make("studio.example"),
      ]),
    );
    assert.strictEqual(scores.spam, 0.03);
  }),
);

it.effect("treats model refusals as permanent and binding failures as retryable", () =>
  Effect.gen(function* () {
    const refused = yield* Effect.flip(
      scoreWithOpenAi(
        {
          run: () =>
            Promise.resolve({ model: "gpt-6-luna", answers: [{ type: "refusal", name: "spam" }] }),
        },
        withoutContext,
      ),
    );
    const unavailable = yield* Effect.flip(
      scoreWithOpenAi({ run: () => Promise.reject(new Error("Unavailable")) }, withoutContext),
    );

    assert.isFalse(refused.retryable);
    assert.isTrue(unavailable.retryable);
  }),
);
