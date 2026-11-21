import * as Domain from "@alchemy.run/domain";
import { Effect } from "effect";

import { InboxStore } from "./inbox-store.ts";
import { Inbox } from "./inbox.projection.ts";
import { InboxEntry, InboxFilter } from "./inbox.ts";
import { CurrentReviewer, ReviewSession, reviewerMay } from "./review-session.middleware.ts";
import {
  InboxUnavailable,
  InvalidInboxCursor,
  SubmissionNotFound,
} from "./submission.rejection.ts";
import { OrganizationId } from "./submission.id.ts";

export class ListSubmissions extends Domain.Query(
  "ListSubmissions",
  {
    input: { organizationId: OrganizationId, ...InboxFilter.fields },
    success: InboxEntry,
    paged: true,
    waitsFor: [Inbox],
    middleware: [ReviewSession],
    rejects: [SubmissionNotFound, InboxUnavailable, InvalidInboxCursor],
  },
  { description: "List the newest submissions within an organization the reviewer can access." },
) {}

export const listSubmissionsLive = ListSubmissions.toLayer(
  Effect.gen(function* () {
    const store = yield* InboxStore;
    return Effect.fnUntraced(function* ({ organizationId, ...filter }, { take, after }) {
      const reviewer = yield* CurrentReviewer;
      if (!reviewerMay(reviewer, organizationId, "read-inbox")) {
        return yield* SubmissionNotFound.make();
      }
      return yield* store.list(organizationId, filter, take, after);
    });
  }),
  { take: { default: 25, max: 50 } },
);
