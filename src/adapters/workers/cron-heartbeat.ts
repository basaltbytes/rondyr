import { DurableObject } from "@alchemy.run/cloudflare/Workers/DurableObject";
import { DurableObjectState } from "@alchemy.run/cloudflare/Workers/DurableObjectState";
import { Clock, Effect, Layer, Schema } from "effect";

import { CronSuccessTime } from "../../domain/submissions/operations-status.ts";
import { CronHeartbeat } from "../../ports/operations-status.ts";
import { StorageUnavailable } from "../../ports/storage.ts";

const key = "last-successful-cron-at";
const decode = Schema.decodeUnknownEffect(Schema.NullOr(CronSuccessTime));

class CronHeartbeatObject extends DurableObject<CronHeartbeatObject>()(
  "CronHeartbeatObject",
  Effect.succeed(
    Effect.gen(function* () {
      const { raw } = yield* DurableObjectState;
      return {
        read: () => Effect.sync(() => raw.storage.kv.get<number>(key) ?? null),
        recordSuccess: (finishedAt: number) =>
          Effect.sync(() =>
            raw.storage.transactionSync(() => {
              const previous = raw.storage.kv.get<number>(key);
              if (previous === undefined || previous < finishedAt) {
                raw.storage.kv.put(key, finishedAt);
              }
            }),
          ),
      };
    }),
  ),
) {}

export const cronHeartbeatLive = Layer.effect(
  CronHeartbeat,
  Effect.gen(function* () {
    const namespace = yield* CronHeartbeatObject;
    return {
      read: Effect.suspend(() => namespace.getByName("stage").read()).pipe(
        Effect.flatMap(decode),
        Effect.catchCause(() => StorageUnavailable.make()),
      ),
      recordSuccess: Clock.currentTimeMillis.pipe(
        Effect.flatMap((finishedAt) => namespace.getByName("stage").recordSuccess(finishedAt)),
        Effect.catchCause(() => StorageUnavailable.make()),
      ),
    };
  }),
);
