import { waitUntil } from "@alchemy.run/cloudflare/Workers/WorkerRuntime";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { Effect } from "effect";

import type { BackgroundTasks } from "../../ports/background-tasks.ts";

/**
 * Background tasks of the current Worker event, through Alchemy's `waitUntil`.
 * Only a request handler can read `RuntimeContext`, so the fetch handler provides
 * this service on each request rather than at init.
 */
export const eventBackgroundTasks: Effect.Effect<
  BackgroundTasks["Service"],
  never,
  RuntimeContext
> = Effect.gen(function* () {
  const runtime = yield* RuntimeContext;
  const run = <R>(task: Effect.Effect<void, never, R>): Effect.Effect<void, never, R> =>
    waitUntil(task).pipe(Effect.provideService(RuntimeContext, runtime));
  return { run };
});
