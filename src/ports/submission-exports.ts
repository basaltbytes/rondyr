import { Context, Effect } from "effect";

import type { InboxFilter } from "../domain/submissions/inbox.ts";
import type { ExportedSubmission } from "../domain/submissions/submission-export.ts";
import type { OrganizationId } from "../domain/submissions/submission.id.ts";
import type { StorageUnavailable } from "./storage.ts";

export interface ExportPage {
  readonly rows: ReadonlyArray<ExportedSubmission>;
  /** The position after the last row, or null after the last page. */
  readonly cursor: string | null;
}

/** The messages of an organization with their full fields, newest first, for an export. */
export class SubmissionExports extends Context.Service<
  SubmissionExports,
  {
    /**
     * The field names of the first `limit` messages of the list, and whether
     * the list has more messages than that.
     */
    readonly outline: (
      organizationId: OrganizationId,
      filter: typeof InboxFilter.Type,
      limit: number,
    ) => Effect.Effect<
      { readonly fieldNames: ReadonlyArray<string>; readonly truncated: boolean },
      StorageUnavailable
    >;
    readonly page: (
      organizationId: OrganizationId,
      filter: typeof InboxFilter.Type,
      after: string | null,
      size: number,
    ) => Effect.Effect<ExportPage, StorageUnavailable>;
  }
>()("rondyr/ports/submission-exports/SubmissionExports") {}
