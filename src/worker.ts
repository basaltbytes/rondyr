import { Layer, Scheduler } from "effect";
import { HttpRouter, HttpServer } from "effect/http";

import { publicRoutes } from "./http/public-routes.ts";

const scheduler = Layer.succeed(Scheduler.Scheduler, new Scheduler.MixedScheduler("sync"));

const app = HttpRouter.toWebHandler(
  publicRoutes.pipe(Layer.provide(HttpServer.layerServices), Layer.provideMerge(scheduler)),
  { disableLogger: true },
);

export default { fetch: (request: Request) => app.handler(request) } satisfies ExportedHandler;
