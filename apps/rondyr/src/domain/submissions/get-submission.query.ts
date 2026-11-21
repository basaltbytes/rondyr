import * as Domain from "@alchemy.run/domain";
import { Effect } from "effect";

import { InboxStore } from "./inbox-store.ts";
import { Inbox } from "./inbox.projection.ts";
import { SubmissionDetail } from "./inbox.ts";
import { CurrentReviewer, ReviewSession, reviewerMay } from "./review-session.middleware.ts";
import { InboxUnavailable, SubmissionNotFound } from "./submission.rejection.ts";
import { OrganizationId, SubmissionId } from "./submission.id.ts";

export class GetSubmission extends Domain.Query(
  "GetSubmission",
  {
    input: { organizationId: OrganizationId, submissionId: SubmissionId },
    success: SubmissionDetail,
    waitsFor: [Inbox],
    middleware: [ReviewSession],
    rejects: [SubmissionNotFound, InboxUnavailable],
  },
  { description: "Read one message and its status within the reviewer's organization." },
) {}

export const getSubmissionLive = GetSubmission.toLayer(
  Effect.gen(function* () {
    const store = yield* InboxStore;
    return Effect.fnUntraced(function* ({ organizationId, submissionId }) {
      const reviewer = yield* CurrentReviewer;
      if (!reviewerMay(reviewer, organizationId, "read-inbox")) {
        return yield* SubmissionNotFound.make();
      }
      return yield* store.detail(organizationId, submissionId);
    });
  }),
);
