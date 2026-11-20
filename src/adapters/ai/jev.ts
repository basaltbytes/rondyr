import { Effect, Schema, SchemaGetter } from "effect";

import { Score } from "../../domain/submissions/classification.ts";
import { ClassificationFailed } from "../../domain/submissions/classifier.external.ts";
import {
  type ClassifierInput,
  classifierDataInstruction,
  classifierSpamInstructions,
} from "../../domain/submissions/classifier-input.ts";
import { mapBindingError } from "./binding-error.ts";
import { aiGatewayOptions } from "./gateway.ts";

const Answer = Schema.Struct({ type: Schema.Literal("noul"), noul: Score });
const Result = Schema.Struct({
  model: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  answers: Schema.Struct({ spam: Answer, relevance: Schema.optionalKey(Answer) }),
});
const Completed = Schema.Struct({ state: Schema.Literal("Completed"), result: Result });

export const decodeJevResponse = Schema.decodeUnknownEffect(
  Schema.Union([Result, Completed]).pipe(
    Schema.decodeTo(Result, {
      decode: SchemaGetter.transform((response) =>
        "result" in response ? response.result : response,
      ),
      encode: SchemaGetter.transform((value) => value),
    }),
  ),
);
const relevance = {
  type: "noul",
  instructions: `Is the submission relevant to the supplied business context? ${classifierDataInstruction}`,
} as const;

interface JevInput {
  readonly state: ClassifierInput;
  readonly questions: {
    readonly spam: { readonly type: "noul"; readonly instructions: string };
    readonly relevance?: typeof relevance;
  };
}

interface JevBinding {
  readonly run: (
    model: "typesafe/jev",
    input: JevInput,
    options: AiOptions,
  ) => ReturnType<Ai["run"]>;
}

export const scoreWithJev = Effect.fn("Jev.score")(function* (
  ai: JevBinding,
  state: ClassifierInput,
) {
  const hasContext = state.business_context !== "";
  const spam = { type: "noul", instructions: classifierSpamInstructions(state.facts) } as const;
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      ai.run(
        "typesafe/jev",
        {
          state,
          questions: hasContext ? { spam, relevance } : { spam },
        },
        { ...aiGatewayOptions, signal },
      ),
    catch: mapBindingError,
  });
  const { model, answers } = yield* decodeJevResponse(response).pipe(
    Effect.mapError(() => ClassificationFailed.make({ retryable: false })),
  );
  if (!hasContext) return { model, spam: answers.spam.noul };
  if (answers.relevance === undefined)
    return yield* ClassificationFailed.make({ retryable: false });
  return { model, spam: answers.spam.noul, relevance: answers.relevance.noul };
});
