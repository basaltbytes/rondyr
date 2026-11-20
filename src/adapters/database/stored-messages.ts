import { Effect, Layer, Schema } from "effect";

import { RepetitionCounts } from "../../domain/submissions/classifier-input.ts";
import { SubmissionFields } from "../../domain/submissions/submission-fields.ts";
import type { OrganizationId, SubmissionId } from "../../domain/submissions/submission.id.ts";
import { StoredMessages, UnreadableMessage } from "../../ports/stored-messages.ts";
import { d1, database } from "./d1.ts";

const StoredMessage = Schema.Struct({
  fields: Schema.fromJsonString(SubmissionFields),
  business_context: Schema.NullOr(Schema.String),
  ...RepetitionCounts.fields,
});
const decodeStoredMessage = Schema.decodeUnknownEffect(StoredMessage);

const read = Effect.fn("StoredMessages.read")(function* (
  submissionId: SubmissionId,
  organizationId: OrganizationId,
) {
  const db = yield* database;
  const row = yield* d1(() =>
    db
      .prepare(`
        SELECT s.fields, f.business_context, s.prior_same_sender, s.prior_same_content
        FROM submissions s JOIN forms f ON f.id = s.form_id
        WHERE s.id = ? AND s.organization_id = ?
      `)
      .bind(submissionId, organizationId)
      .first(),
  );
  const message = yield* decodeStoredMessage(row).pipe(
    Effect.mapError(() => UnreadableMessage.make()),
  );
  const { fields, business_context, ...repetition } = message;
  return { fields, businessContext: business_context, repetition };
});

export const storedMessagesLive = Layer.succeed(StoredMessages, { read });
