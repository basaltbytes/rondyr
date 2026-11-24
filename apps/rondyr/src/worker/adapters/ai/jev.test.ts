import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import { classifierInput } from "../../../domain/submissions/classifier-input.ts";
import { decodeJevResponse, scoreWithJev } from "./jev.ts";

const withoutContext = {
  model: "jev-1.13.0",
  answers: {
    spam: { type: "noul", noul: 0.69 },
    solicitation: { type: "noul", noul: 0 },
  },
} as const;
const contextual = {
  ...withoutContext,
  answers: { ...withoutContext.answers, relevance: { type: "noul", noul: 0.14 } },
} as const;

it.effect("rejects a response with spam and relevance but no solicitation score", () =>
  Effect.gen(function* () {
    const failure = yield* Effect.flip(
      scoreWithJev(
        {
          run: () =>
            Promise.resolve({
              ...contextual,
              answers: { spam: contextual.answers.spam, relevance: contextual.answers.relevance },
            }),
        },
        classifierInput({ message: "Do you offer pottery classes?" }, "Pottery classes", {
          prior_same_sender: 0,
          prior_same_content: 0,
        }),
      ),
    );

    assert.strictEqual(failure._tag, "ClassificationFailed");
    assert.isFalse(failure.retryable);
  }),
);

it.effect("decodes raw Jev responses and the completed Workers AI envelope", () =>
  Effect.gen(function* () {
    const raw = yield* decodeJevResponse(withoutContext);
    const wrapped = yield* decodeJevResponse({ state: "Completed", result: withoutContext });
    const withContext = yield* decodeJevResponse({
      state: "Completed",
      result: contextual,
    });
    assert.deepEqual(raw, withoutContext);
    assert.deepEqual(wrapped, withoutContext);
    assert.deepEqual(withContext, contextual);
  }),
);

it.effect("requires a completed run and valid spam and solicitation scores", () =>
  Effect.gen(function* () {
    const pending = yield* Effect.flip(
      decodeJevResponse({ state: "Running", result: withoutContext }),
    );
    const invalidScore = yield* Effect.flip(
      decodeJevResponse({
        state: "Completed",
        result: {
          ...withoutContext,
          answers: { ...withoutContext.answers, spam: { type: "noul", noul: 2 } },
        },
      }),
    );
    const invalidSolicitation = yield* Effect.flip(
      decodeJevResponse({
        ...withoutContext,
        answers: { ...withoutContext.answers, solicitation: { type: "noul", noul: -0.1 } },
      }),
    );
    assert.strictEqual(pending._tag, "SchemaError");
    assert.strictEqual(invalidScore._tag, "SchemaError");
    assert.strictEqual(invalidSolicitation._tag, "SchemaError");
  }),
);

it.effect("asks the gateway to keep the submission out of its logs and cache", () =>
  Effect.gen(function* () {
    const scores = yield* scoreWithJev(
      {
        run: (model, request, options) => {
          assert.strictEqual(model, "typesafe/jev");
          assert.deepEqual(options.gateway, { id: "default", collectLog: false, skipCache: true });
          assert.deepEqual(request.state, {
            submission_fields: { message: "Do you offer pottery classes?" },
            business_context: "",
            facts: {
              prior_same_sender: 1,
              prior_same_content: 0,
              url_or_html_outside_longest_field: false,
            },
          });
          assert.deepEqual(Object.keys(request.questions), ["spam", "solicitation"]);
          assert.strictEqual(request.questions.solicitation.type, "noul");
          return Promise.resolve(withoutContext);
        },
      },
      classifierInput({ message: "Do you offer pottery classes?" }, "", {
        prior_same_sender: 1,
        prior_same_content: 0,
      }),
    );

    assert.deepEqual(scores, { model: "jev-1.13.0", spam: 0.69, solicitation: 0 });
  }),
);
