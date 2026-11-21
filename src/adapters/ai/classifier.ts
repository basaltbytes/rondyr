import { Effect } from "effect";

import { ClassificationFailed, Classifier } from "../../domain/submissions/classifier.external.ts";
import { classifierInput } from "../../domain/submissions/classifier-input.ts";
import { ClassificationPolicies } from "../../ports/classification-policies.ts";
import { StoredMessages } from "../../ports/stored-messages.ts";
import { scoreWithJev } from "./jev.ts";
import { scoreWithOpenAi } from "./openai-decisions.ts";

const providers = { jev: scoreWithJev, openai: scoreWithOpenAi };

export const classifierLive = Classifier.toLayer(
  Effect.gen(function* () {
    const messages = yield* StoredMessages;
    const policies = yield* ClassificationPolicies;
    return {
      policy: ({ organizationId }) =>
        policies
          .resolve(organizationId)
          .pipe(Effect.mapError(() => ClassificationFailed.make({ retryable: false }))),
      score: Effect.fn("Classifier.score")(function* ({
        submissionId,
        organizationId,
        classifier,
      }) {
        const { env } = yield* Effect.promise(() => import("cloudflare:workers"));
        if (env.AI === undefined) return yield* ClassificationFailed.make({ retryable: false });
        // An unavailable database can recover; a missing or invalid row cannot.
        const message = yield* messages
          .read(submissionId, organizationId)
          .pipe(
            Effect.mapError((error) =>
              ClassificationFailed.make({ retryable: error._tag === "StorageUnavailable" }),
            ),
          );
        const input = classifierInput(
          message.fields,
          message.businessContext,
          message.repetition,
          message.organizationDomains,
        );
        return yield* providers[classifier](env.AI, input).pipe(
          Effect.timeoutOrElse({
            duration: "12 seconds",
            orElse: () => Effect.fail(ClassificationFailed.make({ retryable: true })),
          }),
        );
      }),
    };
  }),
);
