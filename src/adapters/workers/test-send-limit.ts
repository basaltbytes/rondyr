import { Effect, Layer } from "effect";

import { TestSendLimit, TestSendLimitUnavailable } from "../../ports/test-send-limit.ts";

/**
 * Tests per destination through the Workers Rate Limiting binding
 * `TARGET_TEST_RATE_LIMIT`: 3 per minute, counted by Cloudflare per location
 * and approximately. A binding that does not answer refuses the test.
 */
export const testSendLimitLive = Layer.succeed(TestSendLimit, {
  admit: Effect.fn("TestSendLimit.admit")(function* (targetId) {
    const { env } = yield* Effect.promise(() => import("cloudflare:workers"));
    return yield* Effect.tryPromise({
      try: () => env.TARGET_TEST_RATE_LIMIT.limit({ key: `target-test:${targetId}` }),
      catch: () => TestSendLimitUnavailable.make(),
    }).pipe(
      Effect.map(({ success }) => success),
      Effect.tapError(() => Effect.logWarning("Test send limit unavailable; test refused")),
    );
  }),
});
