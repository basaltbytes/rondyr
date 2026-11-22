import { assert, it } from "@effect/vitest";
import { Result } from "effect";

import { parseConnectorDestination } from "./connector-target.ts";

const webhookUrl = "https://discord.com/api/webhooks/1234567890/token-abc";

it("accepts a name and the settings of its connector, with the name on one line", () => {
  const parsed = parseConnectorDestination({
    type: "discord",
    name: "  Sales\nchannel ",
    settings: { webhookUrl },
  });
  assert.deepEqual(
    Result.match(parsed, {
      onSuccess: ({ type, name, settings }) => ({ type, name: String(name), settings }),
      onFailure: () => null,
    }),
    { type: "discord", name: "Sales channel", settings: { webhookUrl } },
  );
});

it("refuses a destination without a name", () => {
  const parsed = parseConnectorDestination({
    type: "discord",
    name: " ",
    settings: { webhookUrl },
  });
  assert.deepEqual(
    Result.match(parsed, { onSuccess: () => null, onFailure: (refusal) => refusal }),
    { error: "name-refused" },
  );
});

it("refuses a name longer than 80 characters", () => {
  const parsed = parseConnectorDestination({
    type: "discord",
    name: "a".repeat(81),
    settings: { webhookUrl },
  });
  assert.isTrue(Result.isFailure(parsed));
});

it("names the setting that the connector refuses", () => {
  const parsed = parseConnectorDestination({
    type: "slack",
    name: "Sales channel",
    settings: { webhookUrl },
  });
  assert.deepEqual(
    Result.match(parsed, { onSuccess: () => null, onFailure: (refusal) => refusal }),
    { error: "settings-refused", field: "webhookUrl", reason: "invalid" },
  );
});
