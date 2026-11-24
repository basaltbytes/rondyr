import { Effect, Schema, SchemaGetter } from "effect";

import { Score } from "../../../domain/submissions/classification-policy.ts";
import { ClassificationFailed } from "../../../domain/submissions/classifier.external.ts";
import {
  type ClassifierInput,
  classifierDataInstruction,
  classifierSpamInstructions,
  solicitationInstruction,
} from "../../../domain/submissions/classifier-input.ts";
import { mapBindingError } from "./binding-error.ts";
import { aiGatewayOptions } from "./gateway.ts";

const Answer = Schema.Struct({ type: Schema.Literal("noul"), noul: Score });
const Result = Schema.Struct({
  model: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  answers: Schema.Struct({
    spam: Answer,
    solicitation: Answer,
    relevance: Schema.optionalKey(Answer),
  }),
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
const solicitation = { type: "noul", instructions: solicitationInstruction } as const;

interface JevInput {
  readonly state: ClassifierInput;
  readonly questions: {
    readonly spam: { readonly type: "noul"; readonly instructions: string };
    readonly solicitation: typeof solicitation;
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
          questions: hasContext ? { spam, solicitation, relevance } : { spam, solicitation },
        },
        { ...aiGatewayOptions, signal },
      ),
    catch: mapBindingError,
  });
  const { model, answers } = yield* decodeJevResponse(response).pipe(
    Effect.mapError(() => ClassificationFailed.make({ retryable: false })),
  );
  const scores = { model, spam: answers.spam.noul, solicitation: answers.solicitation.noul };
  if (!hasContext) return scores;
  if (answers.relevance === undefined)
    return yield* ClassificationFailed.make({ retryable: false });
  return { ...scores, relevance: answers.relevance.noul };
});
