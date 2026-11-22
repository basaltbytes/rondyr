import { assert, it } from "@effect/vitest";
import { Option, Result } from "effect";

import { DeliveryId } from "../delivery.ts";
import type { ConnectorMessage } from "./connector.ts";
import { slack, slackMessage } from "./slack.ts";

const id = DeliveryId.make("7c0d1e2f-3a4b-4c5d-8e6f-0a1b2c3d4e03");

const messageWith = (fields: ConnectorMessage["fields"]): ConnectorMessage => ({
  kind: "submission",
  id,
  submissionId: "submission-1",
  receivedAt: 0,
  form: { publicId: "contact", name: "Contact" },
  fields,
});

const accepts = (webhookUrl: string) => Result.isSuccess(slack.parseSettings({ webhookUrl }));

it("posts the form name, a section per field and the delivery ID to the webhook", () => {
  const request = slack.request(
    { webhookUrl: "https://hooks.slack.com/services/T000/B000/secret" },
    messageWith({ email: "customer@example.test", message: "Is there room in the class?" }),
  );
  assert.deepEqual(Option.getOrUndefined(request), {
    method: "POST",
    url: "https://hooks.slack.com/services/T000/B000/secret",
    headers: {},
    body: {
      text: "Contact",
      blocks: [
        { type: "header", text: { type: "plain_text", text: "Contact", emoji: false } },
        { type: "section", text: { type: "mrkdwn", text: "*email*\ncustomer@example.test" } },
        {
          type: "section",
          text: { type: "mrkdwn", text: "*message*\nIs there room in the class?" },
        },
        { type: "context", elements: [{ type: "mrkdwn", text: `Rondyr · ${id}` }] },
      ],
    },
  });
});

it("escapes what Slack reads as a mention or a link", () => {
  const { blocks } = slackMessage(
    messageWith({ message: "<!channel> R&D <https://evil.test|bank>" }),
  );
  assert.deepEqual(blocks[1], {
    type: "section",
    text: {
      type: "mrkdwn",
      text: "*message*\n&lt;!channel&gt; R&amp;D &lt;https://evil.test|bank&gt;",
    },
  });
});

it("keeps a section within 3000 characters once escaped, without splitting an entity", () => {
  const { blocks } = slackMessage(messageWith({ message: "&".repeat(4000) }));
  const [, section] = blocks;
  const text = section !== undefined && "text" in section ? section.text.text : "";
  assert.isAtMost(text.length, 3000);
  assert.match(text, /^\*message\*\n(?:&amp;)+…$/u);
});

it("shows a dash for a field with an empty value", () => {
  const { blocks } = slackMessage(messageWith({ phone: "" }));
  assert.deepEqual(blocks[1], {
    type: "section",
    text: { type: "mrkdwn", text: "*phone*\n-" },
  });
});

it("accepts the URL of an incoming webhook", () => {
  assert.isTrue(accepts("https://hooks.slack.com/services/T000/B000/secret"));
});

it("refuses the URL of a workflow trigger, which takes another body", () => {
  assert.isFalse(accepts("https://hooks.slack.com/triggers/T000/123/secret"));
});

it("refuses a URL of another host", () => {
  assert.isFalse(accepts("https://hooks.slack.com.example.test/services/T000/B000/secret"));
});
