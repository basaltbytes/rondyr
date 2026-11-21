import { Context, type Effect } from "effect";

import type { OrganizationStatus } from "../domain/submissions/operations-status.ts";
import type { OrganizationId } from "../domain/submissions/submission.id.ts";
import type { StorageUnavailable } from "./storage.ts";

export class OperationsStore extends Context.Service<
  OperationsStore,
  {
    /** The processing status of these organizations. */
    readonly read: (
      organizations: ReadonlyArray<OrganizationId>,
    ) => Effect.Effect<ReadonlyArray<typeof OrganizationStatus.Type>, StorageUnavailable>;
  }
>()("rondyr/ports/operations-status/OperationsStore") {}

export class CronHeartbeat extends Context.Service<
  CronHeartbeat,
  {
    readonly read: Effect.Effect<number | null, StorageUnavailable>;
    readonly recordSuccess: Effect.Effect<void, StorageUnavailable>;
  }
>()("rondyr/ports/operations-status/CronHeartbeat") {}
