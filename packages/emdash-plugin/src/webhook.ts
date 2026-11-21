import { z } from "astro/zod";
import type { EmailMessage, PluginContext } from "emdash";

import { FlatFields, formatNotification, replyToAddress } from "./core/fields.ts";
import { verifyWebhook } from "./core/signature.ts";
import { Store, type DeliveryRecord, type StorageHost } from "./store.ts";

/** Version 1 of the Rondyr webhook payload, docs/webhooks.md. Unknown fields are ignored. */
const WebhookPayload = z.object({
  version: z.literal(1),
  type: z.enum(["submission.accepted", "test"]),
  deliveryId: z.string().min(1).max(128),
  submission: z.object({ id: z.string(), receivedAt: z.string(), fields: FlatFields }),
  form: z.object({ id: z.string(), name: z.string() }),
});

const decoder = new TextDecoder("utf-8", { fatal: true });

function parsePayload(body: Uint8Array) {
  try {
    const parsed = WebhookPayload.safeParse(JSON.parse(decoder.decode(body)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** What the webhook needs from the route context. */
export interface WebhookHost extends StorageHost {
  readonly input: Uint8Array;
  readonly request: Pick<Request, "headers">;
  readonly email?: Pick<NonNullable<PluginContext["email"]>, "send">;
}

/**
 * How the route answers. `emailed` is the number of emails sent; any other
 * outcome is an error status for Rondyr: `401` and `400` are final, `503`
 * makes Rondyr retry.
 */
export type WebhookOutcome =
  | { readonly status: 200; readonly emailed: number }
  | { readonly status: 400 | 401 | 503; readonly code: string };

/**
 * Rondyr's webhook. The route declares a byte body, so the signature is checked
 * over exactly what Rondyr signed. `submission.accepted` sends one email per
 * recipient of each EmDash form linked to the Rondyr form. The route answers
 * `2xx` only once the mailer took every email: otherwise Rondyr retries, and
 * the recipients already emailed for this delivery ID are skipped.
 */
export async function receiveWebhook(
  ctx: WebhookHost,
  webhookSecret: string | null,
  now: number,
): Promise<WebhookOutcome> {
  if (webhookSecret === null) return { status: 503, code: "NOT_CONFIGURED" };
  const verdict = await verifyWebhook(ctx.input, ctx.request.headers, webhookSecret, now);
  if (verdict !== "valid") return { status: 401, code: verdict };
  const payload = parsePayload(ctx.input);
  if (payload === null) return { status: 400, code: "UNKNOWN_PAYLOAD" };
  if (payload.type === "test") return { status: 200, emailed: 0 };

  const store = new Store(ctx);
  const previous = await store.delivery(payload.deliveryId);
  if (previous?.done === true) return { status: 200, emailed: 0 };
  const record: DeliveryRecord = previous ?? { receivedAt: now, sent: [], done: false };
  const links = await store.linksTo(payload.form.id);
  const email = ctx.email;
  if (email === undefined && links.some(({ link }) => link.recipients.length > 0)) {
    return { status: 503, code: "EMAIL_NOT_CONFIGURED" };
  }

  let emailed = 0;
  let failed = false;
  for (const { slug, link } of links) {
    const layout = await store.layout(slug);
    const { subject, text } = formatNotification(
      layout,
      payload.form.name,
      payload.submission.fields,
      payload.submission.receivedAt,
    );
    const replyTo = replyToAddress(layout, payload.submission.fields);
    for (const to of link.recipients) {
      const key = `${slug}:${to}`;
      if (record.sent.includes(key) || email === undefined) continue;
      try {
        const message: EmailMessage = { to, subject, text };
        if (replyTo !== null) message.replyTo = replyTo;
        await email.send(message);
        record.sent.push(key);
        emailed += 1;
      } catch {
        failed = true;
        ctx.log.error("Failed to send a Rondyr notification", {
          deliveryId: payload.deliveryId,
          form: slug,
        });
      }
    }
  }
  await store.putDelivery(payload.deliveryId, { ...record, done: !failed });
  if (failed) return { status: 503, code: "EMAIL_FAILED" };
  return { status: 200, emailed };
}
