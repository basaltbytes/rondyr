import { Layer, Scheduler } from "effect";
import { HttpRouter, HttpServer } from "effect/http";

import { authenticationLive } from "./adapters/authentication/better-auth.ts";
import { authenticationRoutes } from "./http/authentication.ts";
import { publicRoutes } from "./http/public-routes.ts";

const scheduler = Layer.succeed(Scheduler.Scheduler, new Scheduler.MixedScheduler("sync"));
const routes = Layer.merge(publicRoutes, authenticationRoutes);

const app = HttpRouter.toWebHandler(
  routes.pipe(
    Layer.provide(HttpServer.layerServices),
    Layer.provideMerge(Layer.merge(scheduler, authenticationLive)),
  ),
  { disableLogger: true },
);

export default { fetch: (request: Request) => app.handler(request) } satisfies ExportedHandler;
