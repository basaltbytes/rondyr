import { Context, Effect } from "effect";

import type { DeliveryRecord } from "../../domain/deliveries/history.ts";
import type { DeliveryNotFound, SubmissionScope } from "./delivery-store.ts";
import type { StorageUnavailable } from "./storage.ts";

/** The deliveries of the account's submissions, as the admin API reads them. */
export class DeliveryHistory extends Context.Service<
  DeliveryHistory,
  {
    /**
     * The deliveries of a submission to its webhook and email targets, oldest
     * first, each with its attempts. A submission without delivery has none.
     */
    readonly list: (
      submission: SubmissionScope,
    ) => Effect.Effect<
      ReadonlyArray<typeof DeliveryRecord.Type>,
      DeliveryNotFound | StorageUnavailable
    >;
  }
>()("rondyr/worker/ports/delivery-history/DeliveryHistory") {}
