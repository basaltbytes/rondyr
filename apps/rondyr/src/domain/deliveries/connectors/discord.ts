import { DateTime, Schema } from "effect";

import { cut, defineConnector, oneLine, type ConnectorMessage } from "./connector.ts";

// https://discord.com/developers/docs/resources/webhook#execute-webhook
// The webhook ID is a snowflake, and the token is the secret part of the URL.
const webhookUrl =
  /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api(?:\/v\d{1,2})?\/webhooks\/(\d{5,25})\/([\w-]{1,200})\/?$/u;

/** The URL that Discord shows for a webhook of a channel, under "Copy Webhook URL". */
export const DiscordWebhookUrl = Schema.String.check(
  Schema.makeFilter(
    (url: string) =>
      webhookUrl.test(url) ||
      "Expected a Discord webhook URL such as https://discord.com/api/webhooks/123456/abc",
  ),
).pipe(Schema.brand("DiscordWebhookUrl"));

// Limits of an embed: https://discord.com/developers/docs/resources/message#embed-object-embed-limits
const maxTitle = 256;
const maxFields = 25;
const maxFieldName = 256;
const maxFieldValue = 1024;
/** The title, the description, the field names and values and the footer, together. */
const maxEmbed = 6000;
const cutNote = "Some of this message is cut here. The whole message is in the Rondyr inbox.";

// A masked link shows a text that hides its URL. Escaped brackets show as typed. A
// backslash is escaped too: one typed before a bracket would undo the escape.
const escapeLinks = (text: string) => text.replace(/[\\[\]]/gu, "\\$&");

// Type aliases, not interfaces: an alias of an object type is assignable to JSON.
type EmbedField = { readonly name: string; readonly value: string };

type Embed = {
  readonly title: string;
  /** Present when a part of the message does not fit. */
  readonly description?: string;
  readonly fields: ReadonlyArray<EmbedField & { readonly inline: boolean }>;
  readonly footer: { readonly text: string };
  readonly timestamp: string;
};

/**
 * The fields of the message that fit one embed, in order. A field with an
 * empty value is left out, since Discord refuses an empty value. `cutShort`
 * tells that a value was shortened or a field left out.
 */
function embedFields(message: ConnectorMessage, budget: number) {
  const fields: Array<EmbedField> = [];
  let left = budget;
  let cutShort = false;
  for (const [fieldName, fieldValue] of Object.entries(message.fields)) {
    if (fieldValue.trim() === "") continue;
    const name = cut(oneLine(fieldName) || "-", maxFieldName);
    // A value needs room to say something after its name.
    if (fields.length === maxFields || left < name.length + 16) {
      cutShort = true;
      break;
    }
    const whole = escapeLinks(fieldValue);
    const value = cut(whole, Math.min(maxFieldValue, left - name.length));
    cutShort ||= value !== whole;
    fields.push({ name, value });
    left -= name.length + value.length;
  }
  return { fields, cutShort };
}

/** The body of the request to Discord: one embed, which mentions nobody. */
export function discordMessage(message: ConnectorMessage) {
  const title = cut(oneLine(message.form.name) || "Rondyr", maxTitle);
  const footer = `Rondyr · ${message.id}`;
  const { fields, cutShort } = embedFields(
    message,
    maxEmbed - title.length - footer.length - cutNote.length,
  );
  const whole: Embed = {
    title,
    fields: fields.map((field) => ({ ...field, inline: false })),
    footer: { text: footer },
    timestamp: DateTime.formatIso(DateTime.makeUnsafe(message.receivedAt)),
  };
  return {
    embeds: [cutShort ? { ...whole, description: cutNote } : whole],
    // A visitor's text never pings a member, a role or @everyone.
    allowed_mentions: { parse: [] },
  };
}

/** Posts each accepted message to a Discord channel, through a webhook of the channel. */
export const discord = defineConnector({
  type: "discord",
  label: "Discord",
  hosts: ["discord.com"],
  settings: Schema.Struct({ webhookUrl: DiscordWebhookUrl }),
  secrets: ["webhookUrl"],
  request: ({ webhookUrl: url }, message) => {
    const [, id = "", token = ""] = webhookUrl.exec(url) ?? [];
    return {
      method: "POST",
      url: `https://discord.com/api/webhooks/${id}/${token}`,
      headers: {},
      body: discordMessage(message),
    };
  },
  statusHints: new Map([
    [401, "Discord refused the webhook token. Copy the webhook URL again."],
    [404, "Discord no longer has this webhook. Create one for the channel and save its URL."],
  ]),
});
