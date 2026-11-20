import { Effect, Schema } from "effect";

import { ClassificationFailed, Classifier } from "../../domain/submissions/classifier.external.ts";
import { StoredMessages } from "../../ports/stored-messages.ts";
import { scoreWithJev } from "./jev.ts";
import { scoreWithOpenAi } from "./openai-decisions.ts";

const providers = { jev: scoreWithJev, openai: scoreWithOpenAi };

export const ClassifierProvider = Schema.Literals(["jev", "openai"]);

const decodeProvider = Schema.decodeUnknownEffect(ClassifierProvider);

export const classifierLive = Classifier.toLayer(
  Effect.gen(function* () {
    const messages = yield* StoredMessages;
    return {
      score: Effect.fn("Classifier.score")(function* ({ submissionId, organizationId }) {
        const { env } = yield* Effect.promise(() => import("cloudflare:workers"));
        if (env.AI === undefined) return yield* ClassificationFailed.make({ retryable: false });
        const provider = yield* decodeProvider(env.RONDYR_CLASSIFIER ?? "jev").pipe(
          Effect.mapError(() => ClassificationFailed.make({ retryable: false })),
        );
        // An unavailable database can recover; a missing or invalid row cannot.
        const message = yield* messages
          .read(submissionId, organizationId)
          .pipe(
            Effect.mapError((error) =>
              ClassificationFailed.make({ retryable: error._tag === "StorageUnavailable" }),
            ),
          );
        const context = message.businessContext?.trim().slice(0, 2000) ?? "";
        return yield* providers[provider](env.AI, message.fields, context).pipe(
          Effect.timeoutOrElse({
            duration: "12 seconds",
            orElse: () => Effect.fail(ClassificationFailed.make({ retryable: true })),
          }),
        );
      }),
    };
  }),
);
