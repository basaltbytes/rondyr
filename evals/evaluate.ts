import { Duration, Effect, Option, Ref, Schema } from "effect";

import { ClassificationFailed } from "../src/domain/submissions/classifier.external.ts";
import { aiGatewayOptions } from "../src/adapters/ai/gateway.ts";
import { rulesVersion } from "../src/domain/submissions/classification.ts";
import type { ClassifierInput } from "../src/domain/submissions/classifier-input.ts";
import { ResultCache, ScoredCall, Usage, cacheKey, inputDigest } from "./cache.ts";
import { type ClassifierName, classifiers } from "./classifiers.ts";
import type { Corpus, CorpusEntry } from "./corpus.ts";
import { replay } from "./replay.ts";
import {
  type ModelInput,
  type ClassifierModel,
  type ModelBinding,
  type UnsupportedGatewayOptions,
  WorkersAi,
  WorkersAiFailure,
} from "./workers-ai.ts";

export const Outcome = Schema.Union([
  Schema.TaggedStruct("Scored", { call: ScoredCall, cached: Schema.Boolean }),
  Schema.TaggedStruct("Repetition", {}),
  Schema.TaggedStruct("Failed", {
    attempts: Schema.Int,
    retryable: Schema.Boolean,
    httpStatus: Schema.optionalKey(Schema.Int),
    /** The HTTP status and Cloudflare error codes of the last call, never its body. */
    summary: Schema.optionalKey(Schema.String),
  }),
]);

export type Outcome = typeof Outcome.Type;

export interface EntryResult {
  readonly entry: CorpusEntry;
  readonly outcome: Outcome;
  readonly firstOccurrence?: number;
}

export interface ClassifierRun {
  readonly classifier: ClassifierName;
  readonly model: string;
  readonly results: readonly EntryResult[];
}

export interface EvaluationOptions {
  readonly classifiers: readonly ClassifierName[];
  readonly concurrency: number;
  /** The waits after the first and the second failed attempt. */
  readonly retryDelays: readonly [Duration.Input, Duration.Input];
  readonly cache: "reuse" | "refresh";
}

/** Cloudflare refused the token: every other call would fail the same way. */
export class CloudflareRefused extends Schema.TaggedError<
  CloudflareRefused,
  { readonly brand: unique symbol }
>()("CloudflareRefused", { status: Schema.Int }) {}

/** The adapter asked for another model than the one the cache key and the prices assume. */
export class UnexpectedModel extends Schema.TaggedError<
  UnexpectedModel,
  { readonly brand: unique symbol }
>()("UnexpectedModel", {
  classifier: Schema.String,
  expected: Schema.String,
  requested: Schema.String,
}) {}

// The Worker gives a classifier call 12 seconds (src/adapters/ai/classifier.ts) and a submission
// three attempts (src/domain/submissions/classify-submission.saga.ts).
const callTimeout = "12 seconds";
const attemptBudget = 3;

const decodeUsage = Schema.decodeUnknownEffect(Schema.Struct({ usage: Usage }));

interface Observed {
  readonly requested: Option.Option<ClassifierModel>;
  readonly usage: Option.Option<Usage>;
  readonly failure: Option.Option<WorkersAiFailure | UnsupportedGatewayOptions>;
}

const nothingObserved: Observed = {
  requested: Option.none(),
  usage: Option.none(),
  failure: Option.none(),
};

/** One adapter call through a binding that records the model, the usage and the HTTP failure. */
const attempt = Effect.fn("Evaluation.attempt")(function* (
  classifier: ClassifierName,
  input: ClassifierInput,
) {
  const ai = yield* WorkersAi;
  const services = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(services);
  const observed = yield* Ref.make(nothingObserved);
  const binding: ModelBinding = {
    run: (model: ClassifierModel, request: ModelInput, { signal, ...options }: AiOptions) =>
      runPromise(
        Ref.update(observed, (seen) => ({ ...seen, requested: Option.some(model) })).pipe(
          Effect.andThen(ai.run(model, request, options)),
          Effect.tap((body) =>
            decodeUsage(body).pipe(
              Effect.flatMap(({ usage }) =>
                Ref.update(observed, (seen) => ({ ...seen, usage: Option.some(usage) })),
              ),
              Effect.ignore,
            ),
          ),
          Effect.tapError((failure) =>
            Ref.update(observed, (seen) => ({ ...seen, failure: Option.some(failure) })),
          ),
        ),
        signal === undefined ? undefined : { signal },
      ),
  };
  const result = yield* classifiers[classifier].score(binding, input).pipe(
    Effect.timeoutOrElse({
      duration: callTimeout,
      orElse: () =>
        Ref.update(observed, (seen) => ({
          ...seen,
          failure: Option.some(
            WorkersAiFailure.make({ summary: `No answer within ${callTimeout}.` }),
          ),
        })).pipe(Effect.andThen(Effect.fail(ClassificationFailed.make({ retryable: true })))),
    }),
    Effect.timed,
    Effect.result,
  );
  const seen = yield* Ref.get(observed);
  const expected = classifiers[classifier].model;
  if (Option.isSome(seen.requested) && seen.requested.value !== expected) {
    return yield* UnexpectedModel.make({ classifier, expected, requested: seen.requested.value });
  }
  // Invalid gateway options and REST authentication failures would repeat on every call.
  if (Option.isSome(seen.failure) && seen.failure.value._tag === "UnsupportedGatewayOptions") {
    return yield* seen.failure.value;
  }
  const transport = Option.flatMap(seen.failure, (failure) =>
    failure._tag === "WorkersAiFailure" ? Option.some(failure) : Option.none(),
  );
  const status = Option.flatMapNullishOr(transport, (failure) => failure.status);
  if (Option.isSome(status) && (status.value === 401 || status.value === 403)) {
    return yield* CloudflareRefused.make({ status: status.value });
  }
  if (result._tag === "Failure") {
    // The model answered, and the adapter refused the answer: a refusal or an unexpected shape.
    const refused =
      Option.isSome(seen.requested) && Option.isNone(seen.failure)
        ? Option.some(WorkersAiFailure.make({ summary: "The adapter refused the model's answer." }))
        : transport;
    return { _tag: "Failed", retryable: result.failure.retryable, transport: refused } as const;
  }
  const [duration, scores] = result.success;
  const latencyMs = Math.round(Duration.toMillis(duration));
  const call = Option.match(seen.usage, {
    onNone: () => ({ scores, latencyMs }),
    onSome: (usage) => ({ scores, latencyMs, usage }),
  });
  return { _tag: "Scored", call } as const;
});

const scoreEntry = Effect.fn("Evaluation.scoreEntry")(function* (
  classifier: ClassifierName,
  input: ClassifierInput,
  retryDelays: EvaluationOptions["retryDelays"],
) {
  let attempts = 0;
  while (true) {
    attempts += 1;
    const outcome = yield* attempt(classifier, input);
    if (outcome._tag === "Scored")
      return { _tag: "Scored", call: outcome.call, cached: false } as const;
    if (!outcome.retryable || attempts >= attemptBudget) {
      const failed = { _tag: "Failed", attempts, retryable: outcome.retryable } as const;
      return Option.match(outcome.transport, {
        onNone: () => failed,
        onSome: ({ status, summary }) =>
          status === undefined
            ? { ...failed, summary }
            : { ...failed, httpStatus: status, summary },
      });
    }
    yield* Effect.sleep(attempts === 1 ? retryDelays[0] : retryDelays[1]);
  }
});

const evaluateClassifier = Effect.fn("Evaluation.classifier")(function* (
  inputs: ReturnType<typeof replay>,
  classifier: ClassifierName,
  options: EvaluationOptions,
) {
  const ai = yield* WorkersAi;
  const cache = yield* ResultCache;
  const { model } = classifiers[classifier];
  const results = yield* Effect.forEach(
    inputs,
    ({ entry, firstOccurrence, input }) =>
      Effect.gen(function* () {
        if (input === null)
          return { entry, firstOccurrence, outcome: { _tag: "Repetition" } } as const;
        const digest = yield* inputDigest(input);
        const key = cacheKey({
          transport: ai.transport,
          classifier,
          model,
          rulesVersion,
          entryId: entry.id,
          inputDigest: digest,
        });
        const cached = options.cache === "reuse" ? yield* cache.get(key) : Option.none();
        if (Option.isSome(cached)) {
          return {
            entry,
            firstOccurrence,
            outcome: { _tag: "Scored", call: cached.value, cached: true },
          } as const;
        }
        const outcome = yield* scoreEntry(classifier, input, options.retryDelays);
        if (outcome._tag === "Scored") yield* cache.put(key, outcome.call);
        return { entry, firstOccurrence, outcome } satisfies EntryResult;
      }),
    { concurrency: options.concurrency },
  );
  return { classifier, model, results } satisfies ClassifierRun;
});

/**
 * Scores every entry of the corpus with each classifier, through the adapters of the Worker and
 * the gateway options of src/adapters/ai/gateway.ts.
 */
export const evaluate = Effect.fn("Evaluation.run")(function* (
  corpus: Corpus,
  options: EvaluationOptions,
) {
  yield* Effect.annotateCurrentSpan({ corpus: corpus.name, gateway: aiGatewayOptions.gateway.id });
  const inputs = replay(corpus);
  const runs: ClassifierRun[] = [];
  for (const classifier of options.classifiers) {
    const run = yield* evaluateClassifier(inputs, classifier, options);
    runs.push(run);
  }
  return runs;
});
