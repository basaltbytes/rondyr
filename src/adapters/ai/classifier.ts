import { Effect, Schema } from "effect";

import { ClassificationFailed, Classifier } from "../../domain/submissions/classifier.external.ts";
import { SubmissionFields } from "../../domain/submissions/submission-fields.ts";
import { d1, database } from "../database/d1.ts";
import { scoreWithJev } from "./jev.ts";
import { scoreWithOpenAi } from "./openai-decisions.ts";

const StoredMessage = Schema.Struct({
  fields: Schema.fromJsonString(SubmissionFields),
  business_context: Schema.NullOr(Schema.String),
});
const decodeStoredMessage = Schema.decodeUnknownEffect(StoredMessage);
const providers = { jev: scoreWithJev, openai: scoreWithOpenAi };

export const ClassifierProvider = Schema.Literals(["jev", "openai"]);

const decodeProvider = Schema.decodeUnknownEffect(ClassifierProvider);

export const classifierLive = Classifier.toLayer(
  Effect.succeed({
    score: Effect.fn("Classifier.score")(function* ({ submissionId, organizationId }) {
      const { env } = yield* Effect.promise(() => import("cloudflare:workers"));
      if (env.AI === undefined) return yield* ClassificationFailed.make({ retryable: false });
      const provider = yield* decodeProvider(env.RONDYR_CLASSIFIER ?? "jev").pipe(
        Effect.mapError(() => ClassificationFailed.make({ retryable: false })),
      );
      const db = yield* database;
      const row = yield* d1(() =>
        db
          .prepare(`
            SELECT s.fields, f.business_context FROM submissions s JOIN forms f ON f.id = s.form_id
            WHERE s.id = ? AND s.organization_id = ?
          `)
          .bind(submissionId, organizationId)
          .first(),
      ).pipe(Effect.mapError(() => ClassificationFailed.make({ retryable: true })));
      const message = yield* decodeStoredMessage(row).pipe(
        Effect.mapError(() => ClassificationFailed.make({ retryable: false })),
      );
      const context = message.business_context?.trim().slice(0, 2000) ?? "";
      return yield* providers[provider](env.AI, message.fields, context).pipe(
        Effect.timeoutOrElse({
          duration: "12 seconds",
          orElse: () => Effect.fail(ClassificationFailed.make({ retryable: true })),
        }),
      );
    }),
  }),
);
