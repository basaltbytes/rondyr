import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, beforeAll, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  call,
  createInbox,
  json,
  signIn,
} from "../../../tests/integration/organization-fixture.ts";
import { ConnectorTarget } from "../../domain/deliveries/connectors/connector-target.ts";
import { TargetTestResult } from "../../domain/deliveries/history.ts";
import { DestinationTarget } from "../../domain/deliveries/targets.ts";

const readTarget = Schema.decodeUnknownEffect(ConnectorTarget);
const readTargets = Schema.decodeUnknownEffect(Schema.Array(DestinationTarget));
const readTestResult = Schema.decodeUnknownEffect(TargetTestResult);
const Received = Schema.Struct({
  path: Schema.String,
  method: Schema.String,
  body: Schema.String,
});
const readReceived = Schema.decodeUnknownEffect(Schema.Array(Received));

const discordUrl = "https://discord.com/api/webhooks/2000000001/ok";
const airtableToken = "patConnectorRoutes0123456789.abcdef0123456789";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

const answer = (response: Response) =>
  Effect.map(json(response), (body) => ({ status: response.status, body }));

const receivedUnder = Effect.fnUntraced(function* (prefix: string) {
  const response = yield* Effect.promise(() =>
    env.WEBHOOK_RECEIVER.fetch(
      `https://receiver.test/__received?prefix=${encodeURIComponent(prefix)}`,
    ),
  );
  return yield* Effect.flatMap(json(response), readReceived);
});

/** An organization of the signed-in admin, and the path of the targets of its form. */
const organization = Effect.fnUntraced(function* (name: string) {
  const admin = yield* signIn;
  const inbox = yield* createInbox(name, admin);
  const form = inbox.forms[0];
  if (form === undefined) return assert.fail("Expected the contact form");
  return {
    admin,
    targets: `/api/organizations/${inbox.id}/forms/${form.publicId}/targets`,
    target: (id: string) => `/api/organizations/${inbox.id}/targets/${id}`,
  };
});

it.live("refuses a destination of a connector and names what to correct", () =>
  Effect.gen(function* () {
    const { admin, targets } = yield* organization("Connector refusals");
    const requests: ReadonlyArray<Schema.Json> = [
      { type: "discord", name: " ", settings: { webhookUrl: discordUrl } },
      { type: "discord", name: "Sales", settings: {} },
      { type: "discord", name: "Sales", settings: { webhookUrl: "https://example.test/hook" } },
      { type: "discord", name: "Sales", settings: { webhookUrl: discordUrl, channel: "#sales" } },
      { type: "telegram", name: "Sales", settings: {} },
    ];

    const answers = yield* Effect.forEach(requests, (request) =>
      call("POST", targets, request, admin).pipe(
        Effect.flatMap((response) =>
          response.status === 400 && response.headers.get("content-type") === null
            ? Effect.succeed({ status: 400, body: null })
            : answer(response),
        ),
      ),
    );

    assert.deepEqual(answers, [
      { status: 400, body: { error: "name-refused" } },
      { status: 400, body: { error: "settings-refused", field: "webhookUrl", reason: "missing" } },
      { status: 400, body: { error: "settings-refused", field: "webhookUrl", reason: "invalid" } },
      { status: 400, body: { error: "settings-refused", field: "channel", reason: "unknown" } },
      // A type that no connector has is not a destination at all.
      { status: 400, body: null },
    ]);
    const listed = yield* call("GET", targets, undefined, admin).pipe(
      Effect.flatMap(json),
      Effect.flatMap(readTargets),
    );
    assert.deepEqual(listed, []);
  }),
);

it.live("creates a destination and never returns its secret settings", () =>
  Effect.gen(function* () {
    const { admin, targets } = yield* organization("Connector secrets");

    const created = yield* call(
      "POST",
      targets,
      {
        type: "airtable",
        name: "Leads table",
        settings: { token: airtableToken, baseId: "appRoutesSecret01", table: "Leads" },
      },
      admin,
    );
    const createdText = yield* Effect.promise(() => created.text());
    const listed = yield* call("GET", targets, undefined, admin);
    const listedText = yield* Effect.promise(() => listed.text());

    assert.strictEqual(created.status, 201);
    assert.strictEqual(created.headers.get("cache-control"), "no-store");
    assert.notInclude(createdText, airtableToken);
    assert.notInclude(listedText, airtableToken);
    const [target] = yield* Schema.decodeEffect(
      Schema.fromJsonString(Schema.Array(ConnectorTarget)),
    )(listedText);
    assert.deepEqual(
      { ...target, id: "", createdAt: 0 },
      {
        id: "",
        type: "airtable",
        name: "Leads table",
        settings: { baseId: "appRoutesSecret01", table: "Leads" },
        active: true,
        createdAt: 0,
      },
    );
  }),
);

it.live("sends a test message through the deployed Worker to the service of the connector", () =>
  Effect.gen(function* () {
    const { admin, targets, target } = yield* organization("Connector test send");
    const created = yield* call(
      "POST",
      targets,
      { type: "discord", name: "Sales channel", settings: { webhookUrl: discordUrl } },
      admin,
    ).pipe(Effect.flatMap(json), Effect.flatMap(readTarget));

    const tested = yield* call("POST", `${target(created.id)}/test`, undefined, admin);
    const result = yield* Effect.flatMap(json(tested), readTestResult);

    assert.deepEqual([tested.status, result.outcome], [200, "delivered"]);
    const [request, ...others] = yield* receivedUnder("/api/webhooks/2000000001/");
    assert.deepEqual(others, []);
    assert.strictEqual(request?.method, "POST");
    assert.include(request?.body ?? "", "Test message sent from the Rondyr dashboard");
    assert.include(request?.body ?? "", result.testId);
  }),
);

it.live("replaces the name and every setting of a destination, and keeps its type", () =>
  Effect.gen(function* () {
    const { admin, targets, target } = yield* organization("Connector settings");
    const created = yield* call(
      "POST",
      targets,
      {
        type: "airtable",
        name: "Leads table",
        settings: { token: airtableToken, baseId: "appRoutesReplac01", table: "Leads" },
      },
      admin,
    ).pipe(Effect.flatMap(json), Effect.flatMap(readTarget));
    const settings = `${target(created.id)}/settings`;
    const replacement = {
      token: airtableToken,
      baseId: "appRoutesReplac01",
      table: "ok",
      idColumn: "Rondyr ID",
    };

    const asDiscord = yield* call(
      "PUT",
      settings,
      { type: "discord", name: "Sales", settings: { webhookUrl: discordUrl } },
      admin,
    );
    const withoutToken = yield* call(
      "PUT",
      settings,
      { type: "airtable", name: "Leads 2027", settings: { ...replacement, token: "" } },
      admin,
    ).pipe(Effect.flatMap(answer));
    const replaced = yield* call(
      "PUT",
      settings,
      { type: "airtable", name: "Leads 2027", settings: replacement },
      admin,
    ).pipe(Effect.flatMap(answer));
    const tested = yield* call("POST", `${target(created.id)}/test`, undefined, admin).pipe(
      Effect.flatMap(json),
      Effect.flatMap(readTestResult),
    );

    assert.strictEqual(asDiscord.status, 404);
    // A saved secret is not kept: the request gives every setting again.
    assert.deepEqual(withoutToken, {
      status: 400,
      body: { error: "settings-refused", field: "token", reason: "missing" },
    });
    assert.deepEqual(replaced, {
      status: 200,
      body: {
        id: created.id,
        type: "airtable",
        name: "Leads 2027",
        settings: { baseId: "appRoutesReplac01", table: "ok", idColumn: "Rondyr ID" },
        active: true,
        createdAt: created.createdAt,
      },
    });
    // The test reaches the table of the new settings, with the token given again.
    assert.strictEqual(tested.outcome, "delivered");
    const requests = yield* receivedUnder("/v0/appRoutesReplac01/");
    assert.deepEqual(
      requests.map(({ method, path }) => [method, path]),
      // With an ID column, the row of a test is written as the row of a message is.
      [["PATCH", "/v0/appRoutesReplac01/ok"]],
    );
  }),
);

it.live("deactivates and reactivates a destination of a connector", () =>
  Effect.gen(function* () {
    const { admin, targets, target } = yield* organization("Connector status");
    const created = yield* call(
      "POST",
      targets,
      {
        type: "slack",
        name: "Leads",
        settings: { webhookUrl: "https://hooks.slack.com/services/T1/B1/ok" },
      },
      admin,
    ).pipe(Effect.flatMap(json), Effect.flatMap(readTarget));

    const deactivated = yield* call(
      "POST",
      `${target(created.id)}/deactivate`,
      undefined,
      admin,
    ).pipe(Effect.flatMap(json), Effect.flatMap(readTarget));
    const reactivated = yield* call(
      "POST",
      `${target(created.id)}/activate`,
      undefined,
      admin,
    ).pipe(Effect.flatMap(json), Effect.flatMap(readTarget));

    assert.deepEqual([deactivated.active, reactivated.active], [false, true]);
  }),
);

it.live("refuses a destination with a secret when the Worker has no RONDYR_SECRETS_KEY", () =>
  Effect.gen(function* () {
    const { admin, targets } = yield* organization("Connector keyless");

    const refused = yield* call(
      "POST",
      targets,
      { type: "discord", name: "Sales channel", settings: { webhookUrl: discordUrl } },
      admin,
      env.KEYLESS_WORKER,
    ).pipe(Effect.flatMap(answer));

    assert.deepEqual(refused, { status: 503, body: { error: "secrets-key-missing" } });
    const listed = yield* call("GET", targets, undefined, admin).pipe(
      Effect.flatMap(json),
      Effect.flatMap(readTargets),
    );
    assert.deepEqual(listed, []);
  }),
);
