import { Context, Effect, Schema } from "effect";

import type { BlockedTerm } from "../../domain/forms/blocked-term.ts";
import type { OrganizationDomainList } from "../../domain/organizations/organization-domain.ts";
import type { RepetitionCounts } from "../../domain/submissions/classifier-input.ts";
import type { SubmissionFields } from "../../domain/submissions/submission-fields.ts";
import type { OrganizationId, SubmissionId } from "../../domain/submissions/submission.id.ts";
import type { StorageUnavailable } from "./storage.ts";

/** The submission does not exist in the organization, or its stored row does not decode. */
export class UnreadableMessage extends Schema.TaggedError<
  UnreadableMessage,
  { readonly brand: unique symbol }
>()("UnreadableMessage", {}) {}

export interface StoredMessage {
  readonly fields: typeof SubmissionFields.Type;
  readonly businessContext: string | null;
  readonly repetition: RepetitionCounts;
  readonly organizationDomains: OrganizationDomainList;
}

export interface ScreeningMessage extends StoredMessage {
  readonly formBlockedTerms: ReadonlyArray<BlockedTerm>;
  readonly organizationBlockedTerms: ReadonlyArray<BlockedTerm>;
}

export class StoredMessages extends Context.Service<
  StoredMessages,
  {
    /** Read a submission and its form and organization settings for the classifier. */
    readonly read: (
      submissionId: SubmissionId,
      organizationId: OrganizationId,
    ) => Effect.Effect<StoredMessage, StorageUnavailable | UnreadableMessage>;
    /** Read a submission with its current form and organization settings and blocked terms for a dry-run preview. */
    readonly readForScreening: (
      submissionId: SubmissionId,
      organizationId: OrganizationId,
    ) => Effect.Effect<ScreeningMessage, StorageUnavailable | UnreadableMessage>;
  }
>()("rondyr/worker/ports/stored-messages/StoredMessages") {}
