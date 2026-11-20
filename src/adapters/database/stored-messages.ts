import { Effect, Layer, Schema } from "effect";

import { SubmissionFields } from "../../domain/submissions/submission-fields.ts";
import type { OrganizationId, SubmissionId } from "../../domain/submissions/submission.id.ts";
import { StoredMessages, UnreadableMessage } from "../../ports/stored-messages.ts";
import { d1, database } from "./d1.ts";

const StoredMessage = Schema.Struct({
  fields: Schema.fromJsonString(SubmissionFields),
  business_context: Schema.NullOr(Schema.String),
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
        SELECT s.fields, f.business_context FROM submissions s JOIN forms f ON f.id = s.form_id
        WHERE s.id = ? AND s.organization_id = ?
      `)
      .bind(submissionId, organizationId)
      .first(),
  );
  const message = yield* decodeStoredMessage(row).pipe(
    Effect.mapError(() => UnreadableMessage.make()),
  );
  return { fields: message.fields, businessContext: message.business_context };
});

export const storedMessagesLive = Layer.succeed(StoredMessages, { read });
