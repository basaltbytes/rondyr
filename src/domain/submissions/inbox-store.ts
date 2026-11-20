import { Context, Effect } from "effect";

import { InboxCounts, InboxPage, InboxRow, SubmissionDetail, SubmissionStatus } from "./inbox.ts";
import {
  InboxUnavailable,
  InvalidInboxCursor,
  SubmissionNotFound,
} from "./submission.rejection.ts";
import type { OrganizationId, SubmissionId } from "./submission.id.ts";

export interface InboxChange {
  readonly submissionId: SubmissionId;
  readonly version: number;
  readonly status: typeof SubmissionStatus.Type;
  readonly reason: typeof InboxRow.Type.reason;
}

export class InboxStore extends Context.Service<
  InboxStore,
  {
    readonly project: (change: InboxChange) => Effect.Effect<void, InboxUnavailable>;
    readonly list: (
      organizationId: OrganizationId,
      status: typeof SubmissionStatus.Type | undefined,
      take: number,
      after: string | undefined,
    ) => Effect.Effect<typeof InboxPage.Type, InboxUnavailable | InvalidInboxCursor>;
    readonly counts: (
      organizationId: OrganizationId,
    ) => Effect.Effect<typeof InboxCounts.Type, InboxUnavailable>;
    readonly detail: (
      organizationId: OrganizationId,
      submissionId: SubmissionId,
    ) => Effect.Effect<typeof SubmissionDetail.Type, InboxUnavailable | SubmissionNotFound>;
  }
>()("rondyr/domain/submissions/inbox-store/InboxStore") {}
