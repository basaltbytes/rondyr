import { Clock, Effect } from "effect";

import type { ClassifierProvider } from "../../../domain/submissions/classification-policy.ts";
import type { ClassificationSignals } from "../../../domain/submissions/classification.ts";
import type { ClassifierInput } from "../../../domain/submissions/classifier-input.ts";
import { ClassificationFailed } from "../../../domain/submissions/classifier.external.ts";
import {
  classificationDurationMetric,
  recordMetric,
} from "../../../domain/submissions/submission-metrics.ts";
import { scoreWithJev } from "./jev.ts";
import { scoreWithOpenAi } from "./openai-decisions.ts";

const providers = { jev: scoreWithJev, openai: scoreWithOpenAi };

/** The Workers AI binding, or a permanent failure on a deployment without one. */
export const workersAi = Effect.gen(function* () {
  const { env } = yield* Effect.promise(() => import("cloudflare:workers"));
  if (env.AI === undefined) {
    yield* Effect.annotateCurrentSpan({ "classification.failureKind": "missing-ai-binding" });
    return yield* ClassificationFailed.make({ retryable: false, kind: "missing-ai-binding" });
  }
  return env.AI;
});

/** What the classifier input says about a message, without any of its content. */
export function classifierSignals(input: ClassifierInput): ClassificationSignals {
  return {
    hasBusinessContext: input.business_context !== "",
    urlOrHtmlOutsideLongestField: input.facts.url_or_html_outside_longest_field,
    senderMatchesOrganizationDomain: input.facts.sender_matches_organization_domain === true,
  };
}

/**
 * Score a message with one classifier. Live classification and the dry-run
 * preview both go through here, so a preview runs the call that classification
 * would run: same input, same 12-second limit, a timeout that can be retried.
 */
export const scoreMessage = Effect.fn("Classifier.scoreMessage")(function* (
  ai: Ai,
  classifier: ClassifierProvider,
  input: ClassifierInput,
  mode: "live" | "preview",
) {
  const signals = classifierSignals(input);
  yield* Effect.annotateCurrentSpan({
    "classification.classifier": classifier,
    "classification.mode": mode,
    "classification.hasBusinessContext": signals.hasBusinessContext,
    "classification.urlOrHtmlOutsideLongestField": signals.urlOrHtmlOutsideLongestField,
    "classification.senderMatchesOrganizationDomain": signals.senderMatchesOrganizationDomain,
  });
  const startedAt = yield* Clock.currentTimeMillis;
  const scores = yield* providers[classifier](ai, input).pipe(
    Effect.timeoutOrElse({
      duration: "12 seconds",
      orElse: () => Effect.fail(ClassificationFailed.make({ retryable: true, kind: "timeout" })),
    }),
    Effect.tapError((error) =>
      Effect.annotateCurrentSpan({
        "classification.failureKind": error.kind ?? "upstream-error",
        "classification.retryable": error.retryable,
        ...(error.upstreamCode !== undefined && {
          "classification.upstreamCode": error.upstreamCode,
        }),
      }),
    ),
    Effect.ensuring(
      Effect.flatMap(Clock.currentTimeMillis, (finishedAt) =>
        recordMetric(
          classificationDurationMetric,
          { classifier, mode },
          Math.max(0, finishedAt - startedAt),
        ),
      ),
    ),
  );
  return { ...scores, signals };
});
