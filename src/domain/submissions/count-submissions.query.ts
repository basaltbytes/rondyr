import * as Domain from "@alchemy.run/domain";
import { Effect } from "effect";

import { InboxStore } from "./inbox-store.ts";
import { Inbox } from "./inbox.projection.ts";
import { InboxCounts } from "./inbox.ts";
import { CurrentReviewer, ReviewSession } from "./review-session.middleware.ts";
import { InboxUnavailable, SubmissionNotFound } from "./submission.rejection.ts";
import { OrganizationId } from "./submission.id.ts";

export class CountSubmissions extends Domain.Query(
  "CountSubmissions",
  {
    input: { organizationId: OrganizationId },
    success: InboxCounts,
    waitsFor: [Inbox],
    middleware: [ReviewSession],
    rejects: [SubmissionNotFound, InboxUnavailable],
  },
  { description: "Count the submissions of each status within the reviewer's organization." },
) {}

export const countSubmissionsLive = CountSubmissions.toLayer(
  Effect.gen(function* () {
    const store = yield* InboxStore;
    return Effect.fnUntraced(function* ({ organizationId }) {
      const reviewer = yield* CurrentReviewer;
      if (!reviewer.organizations.includes(organizationId)) return yield* SubmissionNotFound.make();
      return yield* store.counts(organizationId);
    });
  }),
);
