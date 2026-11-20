import { assert, it } from "@effect/vitest";
import { ConfigProvider, Context, Effect, Layer, Ref, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { aiGatewayOptions } from "../src/adapters/ai/gateway.ts";
import { scoreWithJev } from "../src/adapters/ai/jev.ts";
import { classifierInput } from "../src/domain/submissions/classifier-input.ts";
import {
  type UnsupportedGatewayOptions,
  WorkersAi,
  type WorkersAiFailure,
  gatewayHeaders,
  workersAiOverHttp,
} from "./workers-ai.ts";

const accountId = "0123456789abcdef0123456789abcdef";
const fields = { content: "Is there room on Saturday?" };
const modelInput = classifierInput(fields, "", { prior_same_sender: 0, prior_same_content: 1 });

const Sent = Schema.Struct({
  model: Schema.String,
  input: Schema.Struct({
    state: Schema.Json,
    questions: Schema.Record(Schema.String, Schema.Json),
  }),
});
const decodeSent = Schema.decodeUnknownEffect(Schema.fromJsonString(Sent));

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** The REST transport over a fake Cloudflare API that answers every request the same way. */
const workersAiAnswering = Effect.fn(function* (status: number, body: string) {
  const requests = yield* Ref.make<readonly Recorded[]>([]);
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      const sent =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      yield* Ref.update(requests, (all) => [
        ...all,
        { url: request.url, method: request.method, headers: request.headers, body: sent },
      ]);
      return HttpClientResponse.fromWeb(request, new Response(body, { status }));
    }),
  );
  const config = ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      CLOUDFLARE_ACCOUNT_ID: accountId,
      CLOUDFLARE_API_TOKEN: "test-token",
    }),
  );
  const context = yield* Layer.build(
    workersAiOverHttp.pipe(
      Layer.provide(Layer.mergeAll(Layer.succeed(HttpClient.HttpClient, client), config)),
    ),
  );
  const ai = Context.get(context, WorkersAi);
  const failures = yield* Ref.make<readonly (WorkersAiFailure | UnsupportedGatewayOptions)[]>([]);
  const services = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(services);
  const score = scoreWithJev(
    {
      run: (model, input, { signal, ...options }) =>
        runPromise(
          ai
            .run(model, input, options)
            .pipe(Effect.tapError((failure) => Ref.update(failures, (all) => [...all, failure]))),
          signal === undefined ? undefined : { signal },
        ),
    },
    modelInput,
  );
  return { score, requests, failures };
});

it("sends the gateway options of the Worker as cf-aig headers", () => {
  assert.deepEqual(gatewayHeaders(aiGatewayOptions), {
    headers: {
      "cf-aig-gateway-id": "default",
      "cf-aig-collect-log": "false",
      "cf-aig-skip-cache": "true",
    },
    unsupported: [],
  });
  assert.deepEqual(
    gatewayHeaders({ tags: ["eval"], gateway: { id: "default", cacheTtl: 60 } }).unsupported,
    ["tags", "gateway.cacheTtl"],
  );
});

it.effect("posts the adapter's model and input to /ai/run and unwraps the API envelope", () =>
  Effect.gen(function* () {
    const { score, requests } = yield* workersAiAnswering(
      200,
      '{"success":true,"errors":[],"messages":[],"result":{"model":"jev-1.13.0","answers":{"spam":{"type":"noul","noul":0.1},"solicitation":{"type":"noul","noul":0.2}}}}',
    );
    const scores = yield* score;
    assert.deepEqual(scores, { model: "jev-1.13.0", spam: 0.1, solicitation: 0.2 });

    const [request] = yield* Ref.get(requests);
    assert(request !== undefined);
    assert.strictEqual(request.method, "POST");
    assert.strictEqual(
      request.url,
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run`,
    );
    assert.include(request.headers, {
      authorization: "Bearer test-token",
      "cf-aig-gateway-id": "default",
      "cf-aig-collect-log": "false",
      "cf-aig-skip-cache": "true",
    });
    const sent = yield* decodeSent(request.body);
    assert.strictEqual(sent.model, "typesafe/jev");
    assert.deepEqual(sent.input.state, modelInput);
    assert.deepEqual(Object.keys(sent.input.questions), ["spam", "solicitation"]);
  }),
);

it.effect("accepts a bare model answer and reports a refusal with its status only", () =>
  Effect.gen(function* () {
    const bare = yield* workersAiAnswering(
      200,
      '{"model":"jev-1.13.0","answers":{"spam":{"type":"noul","noul":0.8},"solicitation":{"type":"noul","noul":0}},"usage":{"input_tokens":120,"output_tokens":0}}',
    );
    const scores = yield* bare.score;
    assert.deepEqual(scores, { model: "jev-1.13.0", spam: 0.8, solicitation: 0 });

    const refused = yield* workersAiAnswering(
      429,
      '{"success":false,"errors":[{"code":3040,"message":"Is there room on Saturday?"}]}',
    );
    const adapterFailure = yield* Effect.flip(refused.score);
    assert.isTrue(adapterFailure.retryable);
    const [failure] = yield* Ref.get(refused.failures);
    assert(failure !== undefined && failure._tag === "WorkersAiFailure");
    assert.strictEqual(failure.status, 429);
    assert.include(failure.summary, "3040");
    assert.notInclude(failure.summary, "Saturday");
  }),
);

it.effect("asks for the credentials without printing them", () =>
  Effect.gen(function* () {
    const missing = yield* Effect.flip(
      Layer.build(
        workersAiOverHttp.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make(() => Effect.die("unused")),
              ),
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({
                  CLOUDFLARE_ACCOUNT_ID: "not-an-id",
                  CLOUDFLARE_API_TOKEN: "secret-token",
                }),
              ),
            ),
          ),
        ),
      ),
    );
    assert.strictEqual(missing._tag, "MissingCredentials");
    assert.notInclude(missing.summary, "not-an-id");
    assert.notInclude(missing.summary, "secret-token");
  }),
);
