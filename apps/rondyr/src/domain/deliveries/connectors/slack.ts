import { Schema } from "effect";

import { cut, defineConnector, oneLine, type ConnectorMessage } from "./connector.ts";

// https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks
// The last part of the path is the secret of the webhook.
const webhookUrl =
  /^https:\/\/hooks\.slack\.com\/services\/[\w-]{1,64}\/[\w-]{1,64}\/[\w-]{1,200}$/u;

/** The URL of an incoming webhook of a Slack app, which posts to one channel. */
export const SlackWebhookUrl = Schema.String.check(
  Schema.makeFilter(
    (url: string) =>
      webhookUrl.test(url) ||
      "Expected a Slack webhook URL such as https://hooks.slack.com/services/T000/B000/abc",
  ),
).pipe(Schema.brand("SlackWebhookUrl"));

/** A header block takes 150 characters, and the text of a section 3000. */
const maxHeader = 150;
const maxSection = 3000;

// Slack reads <...> as a link, a mention or a command such as <!channel>.
// https://docs.slack.dev/messaging/formatting-message-text#escaping
function escape(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** `text` escaped, and cut before the escaping so that no entity is split. */
function escapedWithin(text: string, max: number) {
  let kept = text;
  let escaped = escape(kept);
  while (escaped.length > max) {
    // Escaping lengthens a text by a factor that the next cut assumes again.
    const shorter = Math.floor((kept.length * max) / escaped.length);
    kept = cut(kept, Math.min(shorter, kept.length - 1));
    escaped = escape(kept);
  }
  return escaped;
}

/** The body of the request to Slack: the form name, one section per field, the delivery ID. */
export function slackMessage(message: ConnectorMessage) {
  const form = oneLine(message.form.name) || "Rondyr";
  const sections = Object.entries(message.fields).map(([fieldName, value]) => {
    const name = escapedWithin(oneLine(fieldName) || "-", 300);
    const text = escapedWithin(value, maxSection - name.length - 3);
    return {
      type: "section",
      text: { type: "mrkdwn", text: `*${name}*\n${text.trim() === "" ? "-" : text}` },
    };
  });
  return {
    // Shown in notifications, where blocks are not.
    text: escapedWithin(form, maxSection),
    blocks: [
      { type: "header", text: { type: "plain_text", text: cut(form, maxHeader), emoji: false } },
      ...sections,
      { type: "context", elements: [{ type: "mrkdwn", text: `Rondyr · ${message.id}` }] },
    ],
  };
}

/** Posts each accepted message to a Slack channel, through an incoming webhook. */
export const slack = defineConnector({
  type: "slack",
  label: "Slack",
  hosts: ["hooks.slack.com"],
  settings: Schema.Struct({ webhookUrl: SlackWebhookUrl }),
  secrets: ["webhookUrl"],
  request: ({ webhookUrl: url }, message) => ({
    method: "POST",
    url,
    headers: {},
    body: slackMessage(message),
  }),
  statusHints: new Map([
    [403, "Slack refuses this webhook. A workspace admin may have restricted it."],
    [404, "Slack no longer has this webhook or its channel. Create a webhook and save its URL."],
    [410, "The channel of this webhook is archived."],
  ]),
});
