import { Effect, Layer } from "effect";

import type { DeliveryId } from "../../../domain/deliveries/delivery.ts";
import { QueueUnavailable } from "../../ports/classification-queue.ts";
import { DeliveryQueue } from "../../ports/delivery-queue.ts";

const send = Effect.fn("DeliveryQueue.send")(function* (deliveryIds: ReadonlyArray<DeliveryId>) {
  const { env } = yield* Effect.promise(() => import("cloudflare:workers"));
  yield* Effect.tryPromise({
    try: () =>
      env.DELIVERY_QUEUE.sendBatch(deliveryIds.map((deliveryId) => ({ body: { deliveryId } }))),
    catch: () => QueueUnavailable.make(),
  });
});

export const deliveryQueueLive = Layer.succeed(DeliveryQueue, { send });
