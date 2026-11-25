import { Effect, Schema } from "effect";

import { Score } from "../../../domain/submissions/classification-policy.ts";
import { ClassificationFailed } from "../../../domain/submissions/classifier.external.ts";
import {
  ClassifierInput,
  classifierDataInstruction,
  classifierSpamInstructions,
  solicitationInstruction,
} from "../../../domain/submissions/classifier-input.ts";
import { mapBindingError } from "./binding-error.ts";
import { aiGatewayOptions } from "./gateway.ts";

const Decision = Schema.Struct({
  model: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  answers: Schema.Array(
    Schema.Struct({
      type: Schema.Literal("predicate"),
      name: Schema.Literals(["spam", "solicitation", "relevance"]),
      probability: Score,
    }),
  ),
});
const decodeDecision = Schema.decodeUnknownEffect(
  Schema.Union([Decision, Schema.Struct({ state: Schema.Literal("Completed"), result: Decision })]),
);
const encodeInput = Schema.encodeEffect(Schema.fromJsonString(ClassifierInput));

const relevance = {
  type: "predicate",
  name: "relevance",
  instructions: `Is the submission relevant to the supplied business context? ${classifierDataInstruction}`,
} as const;
const solicitation = {
  type: "predicate",
  name: "solicitation",
  instructions: solicitationInstruction,
} as const;

interface DecisionsInput {
  readonly input: string;
  readonly questions: readonly {
    readonly type: "predicate";
    readonly name: "spam" | "solicitation" | "relevance";
    readonly instructions: string;
  }[];
}

interface DecisionsBinding {
  readonly run: (
    model: "openai/decisions",
    input: DecisionsInput,
    options: AiOptions,
  ) => ReturnType<Ai["run"]>;
}

export const scoreWithOpenAi = Effect.fn("OpenAIDecisions.score")(function* (
  ai: DecisionsBinding,
  message: ClassifierInput,
) {
  const hasContext = message.business_context !== "";
  yield* Effect.annotateCurrentSpan({
    "ai.classifier": "openai",
    "ai.hasBusinessContext": hasContext,
  });
  const spam = {
    type: "predicate",
    name: "spam",
    instructions: classifierSpamInstructions(message.facts),
  } as const;
  const input = yield* encodeInput(message).pipe(
    Effect.mapError(() =>
      ClassificationFailed.make({ retryable: false, kind: "invalid-response" }),
    ),
  );
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      ai.run(
        "openai/decisions",
        { input, questions: hasContext ? [spam, solicitation, relevance] : [spam, solicitation] },
        { ...aiGatewayOptions, signal },
      ),
    catch: mapBindingError,
  });
  const decision = yield* decodeDecision(response).pipe(
    Effect.mapError(() =>
      ClassificationFailed.make({ retryable: false, kind: "invalid-response" }),
    ),
  );
  const { model, answers } = "result" in decision ? decision.result : decision;
  const spamScore = answers.find(({ name }) => name === "spam")?.probability;
  const solicitationScore = answers.find(({ name }) => name === "solicitation")?.probability;
  if (
    spamScore === undefined ||
    solicitationScore === undefined ||
    answers.length !== (hasContext ? 3 : 2)
  ) {
    return yield* ClassificationFailed.make({ retryable: false, kind: "invalid-response" });
  }
  const scores = { model, spam: spamScore, solicitation: solicitationScore };
  if (!hasContext) {
    yield* Effect.annotateCurrentSpan({
      "ai.model": model,
      "ai.score.spam": scores.spam,
      "ai.score.solicitation": scores.solicitation,
    });
    return scores;
  }
  const relevanceScore = answers.find(({ name }) => name === "relevance")?.probability;
  if (relevanceScore === undefined) {
    return yield* ClassificationFailed.make({ retryable: false, kind: "invalid-response" });
  }
  yield* Effect.annotateCurrentSpan({
    "ai.model": model,
    "ai.score.spam": scores.spam,
    "ai.score.solicitation": scores.solicitation,
    "ai.score.relevance": relevanceScore,
  });
  return { ...scores, relevance: relevanceScore };
});
