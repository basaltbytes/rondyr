import * as Domain from "@alchemy.run/domain";
import { Effect, Schema } from "effect";

import { InboxStore } from "./inbox-store.ts";
import { Inbox } from "./inbox.projection.ts";
import { SubmissionDetail, SubmissionStatus } from "./inbox.ts";
import { CurrentReviewer, ReviewSession } from "./review-session.middleware.ts";
import {
  InboxUnavailable,
  InvalidInboxCursor,
  SubmissionNotFound,
} from "./submission.rejection.ts";
import { OrganizationId } from "./submission.id.ts";

export class ListSubmissions extends Domain.Query(
  "ListSubmissions",
  {
    input: { organizationId: OrganizationId, status: Schema.optionalKey(SubmissionStatus) },
    success: SubmissionDetail,
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
    return Effect.fnUntraced(function* ({ organizationId, status }, { take, after }) {
      const reviewer = yield* CurrentReviewer;
      if (!reviewer.organizations.includes(organizationId)) return yield* SubmissionNotFound.make();
      return yield* store.list(organizationId, status, take, after);
    });
  }),
  { take: { default: 25, max: 50 } },
);
