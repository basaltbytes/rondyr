import { Clock, Effect } from "effect";

import {
  ClassificationFailed,
  Classifier,
} from "../../../domain/submissions/classifier.external.ts";
import { classifierInput } from "../../../domain/submissions/classifier-input.ts";
import {
  classificationDurationMetric,
  recordMetric,
} from "../../../domain/submissions/submission-metrics.ts";
import { ClassificationPolicies } from "../../ports/classification-policies.ts";
import { OrganizationQuotas } from "../../ports/organization-quotas.ts";
import { StoredMessages } from "../../ports/stored-messages.ts";
import { scoreWithJev } from "./jev.ts";
import { scoreWithOpenAi } from "./openai-decisions.ts";

const providers = { jev: scoreWithJev, openai: scoreWithOpenAi };

export const classifierLive = Classifier.toLayer(
  Effect.gen(function* () {
    const messages = yield* StoredMessages;
    const policies = yield* ClassificationPolicies;
    const quotas = yield* OrganizationQuotas;
    return {
      // An unavailable database can recover; an unknown classifier or an invalid policy cannot.
      policy: ({ organizationId }) =>
        policies.resolve(organizationId).pipe(
          Effect.catchTags({
            StorageUnavailable: () =>
              Effect.fail(
                ClassificationFailed.make({ retryable: true, kind: "policy-unavailable" }),
              ),
            ClassificationPolicyUnreadable: () =>
              Effect.fail(
                ClassificationFailed.make({ retryable: false, kind: "policy-unreadable" }),
              ),
          }),
        ),
      // An unavailable database can recover.
      reserveEscalation: ({ organizationId }) =>
        quotas
          .reserveClassification(organizationId)
          .pipe(
            Effect.mapError(() =>
              ClassificationFailed.make({ retryable: true, kind: "reservation-unavailable" }),
            ),
          ),
      score: Effect.fn("Classifier.score")(function* ({
        submissionId,
        organizationId,
        classifier,
      }) {
        yield* Effect.annotateCurrentSpan({
          submissionId,
          organizationId,
          "classification.classifier": classifier,
        });
        const { env } = yield* Effect.promise(() => import("cloudflare:workers"));
        if (env.AI === undefined) {
          yield* Effect.annotateCurrentSpan({ "classification.failureKind": "missing-ai-binding" });
          return yield* ClassificationFailed.make({ retryable: false, kind: "missing-ai-binding" });
        }
        // An unavailable database can recover; a missing or invalid row cannot.
        const message = yield* messages.read(submissionId, organizationId).pipe(
          Effect.mapError((error) =>
            ClassificationFailed.make({
              retryable: error._tag === "StorageUnavailable",
              kind: "message-unreadable",
            }),
          ),
        );
        const input = classifierInput(
          message.fields,
          message.businessContext,
          message.repetition,
          message.organizationDomains,
        );
        const signals = {
          hasBusinessContext: input.business_context !== "",
          urlOrHtmlOutsideLongestField: input.facts.url_or_html_outside_longest_field,
          senderMatchesOrganizationDomain: input.facts.sender_matches_organization_domain === true,
        };
        yield* Effect.annotateCurrentSpan({
          "classification.hasBusinessContext": signals.hasBusinessContext,
          "classification.urlOrHtmlOutsideLongestField": signals.urlOrHtmlOutsideLongestField,
          "classification.senderMatchesOrganizationDomain": signals.senderMatchesOrganizationDomain,
        });
        const startedAt = yield* Clock.currentTimeMillis;
        const scores = yield* providers[classifier](env.AI, input).pipe(
          Effect.timeoutOrElse({
            duration: "12 seconds",
            orElse: () =>
              Effect.fail(ClassificationFailed.make({ retryable: true, kind: "timeout" })),
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
                { classifier, mode: "live" },
                Math.max(0, finishedAt - startedAt),
              ),
            ),
          ),
        );
        return { ...scores, signals };
      }),
    };
  }),
);
