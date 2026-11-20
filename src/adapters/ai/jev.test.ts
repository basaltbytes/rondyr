import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import { decodeJevResponse, scoreWithJev } from "./jev.ts";

const spamOnly = { model: "jev-1.13.0", answers: { spam: { type: "noul", noul: 0.69 } } } as const;
const contextual = {
  ...spamOnly,
  answers: { ...spamOnly.answers, relevance: { type: "noul", noul: 0.14 } },
} as const;

it.effect("decodes raw Jev responses and the completed Workers AI envelope", () =>
  Effect.gen(function* () {
    const raw = yield* decodeJevResponse(spamOnly);
    const wrapped = yield* decodeJevResponse({ state: "Completed", result: spamOnly });
    const withContext = yield* decodeJevResponse({
      state: "Completed",
      result: contextual,
    });
    assert.deepEqual(raw, spamOnly);
    assert.deepEqual(wrapped, spamOnly);
    assert.deepEqual(withContext, contextual);
  }),
);

it.effect("requires a completed run and a valid spam score", () =>
  Effect.gen(function* () {
    const pending = yield* Effect.flip(decodeJevResponse({ state: "Running", result: spamOnly }));
    const invalidScore = yield* Effect.flip(
      decodeJevResponse({
        state: "Completed",
        result: { ...spamOnly, answers: { spam: { type: "noul", noul: 2 } } },
      }),
    );
    assert.strictEqual(pending._tag, "SchemaError");
    assert.strictEqual(invalidScore._tag, "SchemaError");
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
          });
          assert.deepEqual(Object.keys(request.questions), ["spam"]);
          return Promise.resolve(spamOnly);
        },
      },
      { message: "Do you offer pottery classes?" },
      "",
    );

    assert.deepEqual(scores, { model: "jev-1.13.0", spam: 0.69 });
  }),
);
