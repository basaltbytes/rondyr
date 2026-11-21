import { Context, Effect } from "effect";

import type { DeliveryId } from "../domain/deliveries/delivery.ts";
import type { QueueUnavailable } from "./classification-queue.ts";

export class DeliveryQueue extends Context.Service<
  DeliveryQueue,
  {
    /** Send one message per delivery. The queue can deliver a message more than once. */
    readonly send: (
      deliveryIds: ReadonlyArray<DeliveryId>,
    ) => Effect.Effect<void, QueueUnavailable>;
  }
>()("rondyr/ports/delivery-queue/DeliveryQueue") {}
