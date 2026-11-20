import { Effect } from "effect";

import { StorageUnavailable } from "../../ports/storage.ts";

export const database = Effect.promise(() => import("cloudflare:workers")).pipe(
  Effect.map(({ env }) => env.DB),
);

export const d1 = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: () => StorageUnavailable.make() });
