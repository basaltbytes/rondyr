import { Context, Effect } from "effect";

export class BackgroundTasks extends Context.Service<
  BackgroundTasks,
  {
    /**
     * Start `task` without waiting for it. The platform keeps the current event
     * alive until the task settles, so the response is not delayed.
     */
    readonly run: <R>(task: Effect.Effect<void, never, R>) => Effect.Effect<void, never, R>;
  }
>()("rondyr/worker/ports/background-tasks/BackgroundTasks") {}
