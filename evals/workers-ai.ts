import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import type { scoreWithJev } from "../src/adapters/ai/jev.ts";
import type { scoreWithOpenAi } from "../src/adapters/ai/openai-decisions.ts";

type JevBinding = Parameters<typeof scoreWithJev>[0];
type DecisionsBinding = Parameters<typeof scoreWithOpenAi>[0];

/** A model that one of the adapters asks for. */
export type ClassifierModel =
  | Parameters<JevBinding["run"]>[0]
  | Parameters<DecisionsBinding["run"]>[0];

/** The input that one of the adapters sends. */
export type ClassifierInput =
  | Parameters<JevBinding["run"]>[1]
  | Parameters<DecisionsBinding["run"]>[1];

/** The part of the Workers AI binding that both adapters call. */
export interface ModelBinding {
  readonly run: (
    model: ClassifierModel,
    input: ClassifierInput,
    options: AiOptions,
  ) => ReturnType<Ai["run"]>;
}

export class WorkersAiFailure extends Schema.TaggedError<
  WorkersAiFailure,
  { readonly brand: unique symbol }
>()("WorkersAiFailure", {
  /** The HTTP status, when Cloudflare answered. */
  status: Schema.optionalKey(Schema.Int),
  summary: Schema.String,
}) {}

export class MissingCredentials extends Schema.TaggedError<
  MissingCredentials,
  { readonly brand: unique symbol }
>()("MissingCredentials", { summary: Schema.String }) {}

export class UnsupportedGatewayOptions extends Schema.TaggedError<
  UnsupportedGatewayOptions,
  { readonly brand: unique symbol }
>()("UnsupportedGatewayOptions", { options: Schema.Array(Schema.String) }) {}

export const Transport = Schema.Literals(["workers-ai", "dry"]);

export type Transport = typeof Transport.Type;

/** Runs a model as `env.AI.run` would, outside a Worker. */
export class WorkersAi extends Context.Service<
  WorkersAi,
  {
    readonly transport: Transport;
    readonly run: (
      model: ClassifierModel,
      input: ClassifierInput,
      options: AiOptions,
    ) => Effect.Effect<Schema.JsonObject, WorkersAiFailure | UnsupportedGatewayOptions>;
  }
>()("rondyr/evals/workers-ai/WorkersAi") {}

/**
 * The AI Gateway options of `env.AI.run`, as the `cf-aig-*` headers of the REST API
 * (https://developers.cloudflare.com/ai-gateway/usage/rest-api/#per-request-configuration).
 * An option without a known header is refused, so that a privacy option added to
 * src/adapters/ai/gateway.ts is never dropped silently.
 */
export function gatewayHeaders(options: AiOptions) {
  const { gateway, ...others } = options;
  const unsupported = Object.keys(others);
  const headers: Record<string, string> = {};
  if (gateway === undefined) return { headers, unsupported: [...unsupported, "gateway"] };
  const { id, collectLog, skipCache, ...otherGatewayOptions } = gateway;
  unsupported.push(...Object.keys(otherGatewayOptions).map((name) => `gateway.${name}`));
  headers["cf-aig-gateway-id"] = id;
  if (collectLog !== undefined) headers["cf-aig-collect-log"] = String(collectLog);
  if (skipCache !== undefined) headers["cf-aig-skip-cache"] = String(skipCache);
  return { headers, unsupported };
}

const decodeObject = Schema.decodeUnknownEffect(Schema.JsonObject);
// The Cloudflare API wraps results as { success, result, errors, messages }. The model pages show
// the bare model output for POST /ai/run, so both shapes are accepted.
const decodeEnvelope = Schema.decodeUnknownEffect(
  Schema.Struct({ success: Schema.Boolean, result: Schema.JsonObject }),
);
// Only error codes are kept: an error message can repeat part of the request.
const decodeErrorCodes = Schema.decodeUnknownEffect(
  Schema.Struct({ errors: Schema.Array(Schema.Struct({ code: Schema.Int })) }),
);

const AccountId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u));

const credentials = Effect.gen(function* () {
  const accountId = yield* Config.String("CLOUDFLARE_ACCOUNT_ID").pipe(Config.withDefault(""));
  const token = yield* Config.Redacted("CLOUDFLARE_API_TOKEN").pipe(Config.option);
  if (accountId === "" || Option.isNone(token) || Redacted.value(token.value) === "") {
    return yield* MissingCredentials.make({
      summary:
        "Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN to call Workers AI, or pass --dry to run with fake scores.",
    });
  }
  if (!Schema.is(AccountId)(accountId)) {
    return yield* MissingCredentials.make({
      summary: "CLOUDFLARE_ACCOUNT_ID must be the 32-character hexadecimal id of the account.",
    });
  }
  return { accountId, token: token.value };
}).pipe(
  Effect.catchTag("ConfigError", () =>
    Effect.fail(
      MissingCredentials.make({
        summary: "CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN cannot be read.",
      }),
    ),
  ),
);

/**
 * POST /accounts/{account_id}/ai/run with { model, input }
 * (https://developers.cloudflare.com/ai-gateway/usage/rest-api/#airun--universal-endpoint).
 * The token needs Account > Workers AI > Read.
 */
export const workersAiOverHttp = Layer.effect(
  WorkersAi,
  Effect.gen(function* () {
    const { accountId, token } = yield* credentials;
    const client = yield* HttpClient.HttpClient;
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run`;

    const run = Effect.fn("WorkersAi.run")(function* (
      model: ClassifierModel,
      input: ClassifierInput,
      options: AiOptions,
    ) {
      const { headers, unsupported } = gatewayHeaders(options);
      if (unsupported.length > 0)
        return yield* UnsupportedGatewayOptions.make({ options: unsupported });
      const request = yield* HttpClientRequest.post(endpoint).pipe(
        HttpClientRequest.setHeaders({
          ...headers,
          authorization: `Bearer ${Redacted.value(token)}`,
        }),
        HttpClientRequest.bodyJson({ model, input }),
        Effect.mapError(() => WorkersAiFailure.make({ summary: "The request cannot be encoded." })),
      );
      const response = yield* client.execute(request).pipe(
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.mapError(() =>
          WorkersAiFailure.make({ summary: "Workers AI could not be reached." }),
        ),
      );
      const { status } = response;
      const body = yield* response.json.pipe(Effect.option);
      if (status < 200 || status >= 300) {
        const codes = yield* Option.match(body, {
          onNone: () => Effect.succeed([]),
          onSome: (json) =>
            decodeErrorCodes(json).pipe(
              Effect.map(({ errors }) => errors.map(({ code }) => code)),
              Effect.orElseSucceed(() => []),
            ),
        });
        const detail = codes.length > 0 ? ` (error codes ${codes.join(", ")})` : "";
        return yield* WorkersAiFailure.make({
          status,
          summary: `Workers AI answered HTTP ${status}${detail}.`,
        });
      }
      const json = yield* decodeObject(Option.getOrNull(body)).pipe(
        Effect.mapError(() =>
          WorkersAiFailure.make({ status, summary: "Workers AI answered without a JSON object." }),
        ),
      );
      const envelope = yield* decodeEnvelope(json).pipe(Effect.option);
      if (Option.isNone(envelope)) return json;
      if (!envelope.value.success) {
        return yield* WorkersAiFailure.make({ status, summary: "Workers AI reported a failure." });
      }
      return envelope.value.result;
    });

    return { transport: "workers-ai", run };
  }),
);

export const workersAiRest = workersAiOverHttp.pipe(Layer.provide(FetchHttpClient.layer));

// FNV-1a: stable pseudo-scores for the dry run, without a model.
function pseudoScore(text: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return Math.round((hash / 0x1_0000_0000) * 1000) / 1000;
}

function dryAnswer(model: ClassifierModel, input: ClassifierInput): Schema.JsonObject {
  if ("state" in input) {
    const { submission_fields: fields, business_context: context } = input.state;
    const text = [...Object.entries(fields).flat(), context].join("\u0000");
    const answers: Record<string, Schema.JsonObject> = {};
    for (const name of Object.keys(input.questions)) {
      answers[name] = { type: "noul", noul: pseudoScore(`${model}\u0000${name}\u0000${text}`) };
    }
    return { model: "dry-jev", answers, usage: { input_tokens: text.length, output_tokens: 0 } };
  }
  const answers = input.questions.map(({ name }) => ({
    type: "predicate",
    name,
    probability: pseudoScore(`${model}\u0000${name}\u0000${input.input}`),
  }));
  return {
    model: "dry-openai",
    answers,
    usage: { input_tokens: input.input.length, output_tokens: 0 },
  };
}

/** Answers like Workers AI with stable fake scores, so the whole run works without credentials. */
export const workersAiDry = Layer.succeed(WorkersAi, {
  transport: "dry",
  run: Effect.fn("WorkersAi.dryRun")(function* (model, input, options) {
    const { unsupported } = gatewayHeaders(options);
    if (unsupported.length > 0)
      return yield* UnsupportedGatewayOptions.make({ options: unsupported });
    return dryAnswer(model, input);
  }),
});
