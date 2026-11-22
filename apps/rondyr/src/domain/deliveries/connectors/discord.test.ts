import { assert, it } from "@effect/vitest";
import { Option, Result } from "effect";

import { DeliveryId } from "../delivery.ts";
import type { ConnectorMessage } from "./connector.ts";
import { discord, discordMessage } from "./discord.ts";

const id = DeliveryId.make("7c0d1e2f-3a4b-4c5d-8e6f-0a1b2c3d4e02");

const messageWith = (fields: ConnectorMessage["fields"]): ConnectorMessage => ({
  kind: "submission",
  id,
  submissionId: "submission-1",
  receivedAt: 0,
  form: { publicId: "contact", name: "Contact" },
  fields,
});

const accepts = (webhookUrl: string) => Result.isSuccess(discord.parseSettings({ webhookUrl }));

it("posts one embed to the webhook, with a field of the embed per field of the message", () => {
  const request = discord.request(
    { webhookUrl: "https://discord.com/api/webhooks/1234567890/token-abc" },
    messageWith({ email: "customer@example.test", message: "Is there room in the class?" }),
  );
  assert.deepEqual(Option.getOrUndefined(request), {
    method: "POST",
    url: "https://discord.com/api/webhooks/1234567890/token-abc",
    headers: {},
    body: {
      embeds: [
        {
          title: "Contact",
          fields: [
            { name: "email", value: "customer@example.test", inline: false },
            { name: "message", value: "Is there room in the class?", inline: false },
          ],
          footer: { text: `Rondyr · ${id}` },
          timestamp: "1970-01-01T00:00:00.000Z",
        },
      ],
      allowed_mentions: { parse: [] },
    },
  });
});

it("sends to discord.com whichever Discord host the saved URL names", () => {
  const request = discord.request(
    { webhookUrl: "https://canary.discordapp.com/api/v10/webhooks/1234567890/token-abc/" },
    messageWith({ message: "Hello" }),
  );
  assert.strictEqual(
    Option.getOrUndefined(request)?.url,
    "https://discord.com/api/webhooks/1234567890/token-abc",
  );
});

it("accepts the webhook URL that Discord shows", () => {
  assert.isTrue(accepts("https://discord.com/api/webhooks/1234567890/token-abc"));
});

it("refuses a URL of another host that looks like a Discord webhook", () => {
  assert.isFalse(accepts("https://discord.com.example.test/api/webhooks/1234567890/token-abc"));
});

it("refuses a Discord URL that is not a webhook", () => {
  assert.isFalse(accepts("https://discord.com/channels/1234567890/1234567890"));
});

it("refuses a webhook URL with a query string", () => {
  assert.isFalse(accepts("https://discord.com/api/webhooks/1234567890/token-abc?wait=true"));
});

it("escapes the brackets of a masked link, so that a link shows its URL", () => {
  const { embeds } = discordMessage(messageWith({ message: "[your bank](https://evil.test)" }));
  assert.strictEqual(embeds[0]?.fields[0]?.value, "\\[your bank\\](https://evil.test)");
});

it("escapes a backslash too, so that one typed before a bracket does not undo the escape", () => {
  const { embeds } = discordMessage(messageWith({ message: "\\[bank\\](https://evil.test)" }));
  assert.strictEqual(embeds[0]?.fields[0]?.value, "\\\\\\[bank\\\\\\](https://evil.test)");
});

it("leaves out a field with an empty value, which Discord refuses", () => {
  const { embeds } = discordMessage(messageWith({ phone: "  ", message: "Hello" }));
  assert.deepEqual(
    embeds[0]?.fields.map(({ name }) => name),
    ["message"],
  );
});

it("cuts a value longer than a field of an embed and says that the message is cut", () => {
  const { embeds } = discordMessage(messageWith({ message: "a".repeat(4000) }));
  assert.deepEqual(
    [embeds[0]?.fields[0]?.value.length, embeds[0]?.description],
    [1024, "Some of this message is cut here. The whole message is in the Rondyr inbox."],
  );
});

it("keeps the largest message within the limits of one embed", () => {
  const fields = Object.fromEntries(
    Array.from({ length: 32 }, (_, index) => [`field-${index}`, "a".repeat(500)]),
  );
  const [embed] = discordMessage(messageWith(fields)).embeds;
  const characters =
    (embed?.title.length ?? 0) +
    (embed?.description?.length ?? 0) +
    (embed?.footer.text.length ?? 0) +
    (embed?.fields ?? []).reduce((sum, { name, value }) => sum + name.length + value.length, 0);
  assert.isAtMost(embed?.fields.length ?? 0, 25);
  assert.isAtMost(characters, 6000);
});
