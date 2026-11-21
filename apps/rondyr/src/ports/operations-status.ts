import { Context, type Effect } from "effect";

import type {
  OrganizationStatus,
  StuckSubmissions,
} from "../domain/submissions/operations-status.ts";
import type { OrganizationId, UserId } from "../domain/submissions/submission.id.ts";
import type { StorageUnavailable } from "./storage.ts";

export class OperationsStore extends Context.Service<
  OperationsStore,
  {
    /** The processing status of these organizations. */
    readonly read: (
      organizations: ReadonlyArray<OrganizationId>,
    ) => Effect.Effect<ReadonlyArray<typeof OrganizationStatus.Type>, StorageUnavailable>;
    /** The stuck submissions of an organization the account is a member of, oldest first. */
    readonly stuck: (
      userId: typeof UserId.Type,
      organizationId: OrganizationId,
    ) => Effect.Effect<typeof StuckSubmissions.Type, StorageUnavailable>;
  }
>()("rondyr/ports/operations-status/OperationsStore") {}

export class CronHeartbeat extends Context.Service<
  CronHeartbeat,
  {
    readonly read: Effect.Effect<number | null, StorageUnavailable>;
    readonly recordSuccess: Effect.Effect<void, StorageUnavailable>;
  }
>()("rondyr/ports/operations-status/CronHeartbeat") {}
