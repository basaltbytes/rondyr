import { Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";

const Health = Schema.Struct({ status: Schema.Literal("ok") });
const respondHealth = HttpServerResponse.schemaJson(Health);

export const publicRoutes = HttpRouter.add(
  "GET",
  "/health",
  respondHealth({ status: "ok" }, { headers: { "cache-control": "no-store" } }),
);
