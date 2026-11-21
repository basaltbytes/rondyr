import * as Domain from "@alchemy.run/domain";
import { Schema } from "effect";

import type { DecisionAuthor } from "./decision-author.ts";
import { ReviewSession } from "./review-session.middleware.ts";
import { SubmissionNotFound, SubmissionNotReviewable } from "./submission.rejection.ts";
import { ApiTokenId, OrganizationId, SubmissionId, UserId } from "./submission.id.ts";

type Dismissal = { readonly organizationId: OrganizationId } & DecisionAuthor;

export class SubmissionDismissed extends Domain.Event("SubmissionDismissed", {
  organizationId: OrganizationId,
  // `Domain.Event` takes one flat field map, so its schema cannot say "one of these two keys".
  // Dismissals stored before API tokens have only `reviewerId`, so moving the author into a
  // nested union would stop them from decoding. Both keys stay optional in the schema, and
  // `make` below requires exactly one of them. The Effect language service already refuses
  // `new` on a Schema class.
  reviewerId: Schema.optionalKey(UserId),
  apiTokenId: Schema.optionalKey(ApiTokenId),
}) {
  static override make(props: Dismissal, options?: Schema.MakeOptions) {
    return super.make(props, options);
  }
}

export class DismissSubmission extends Domain.Command(
  "DismissSubmission",
  {
    target: SubmissionId,
    events: [SubmissionDismissed],
    middleware: [ReviewSession],
    rejects: [SubmissionNotFound, SubmissionNotReviewable],
  },
  { description: "Archive a quarantined submission as an organization reviewer." },
) {}
