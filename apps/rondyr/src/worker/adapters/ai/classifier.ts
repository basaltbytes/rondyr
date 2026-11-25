import { Effect } from "effect";

import {
  ClassificationFailed,
  Classifier,
} from "../../../domain/submissions/classifier.external.ts";
import { classifierInput } from "../../../domain/submissions/classifier-input.ts";
import { ClassificationPolicies } from "../../ports/classification-policies.ts";
import { OrganizationQuotas } from "../../ports/organization-quotas.ts";
import { StoredMessages } from "../../ports/stored-messages.ts";
import { scoreMessage, workersAi } from "./scoring.ts";

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
        const ai = yield* workersAi;
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
        return yield* scoreMessage(ai, classifier, input, "live");
      }),
    };
  }),
);
