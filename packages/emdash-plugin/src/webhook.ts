import { z } from "astro/zod";
import type { EmailMessage, PluginContext } from "emdash";

import { FlatFields, formatNotification, replyToAddress, type FormLayout } from "./core/fields.ts";
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

/**
 * How long one request holds a delivery while it sends its emails. Rondyr
 * waits 30 seconds for an answer and retries a minute later at the earliest;
 * a retry that finds the delivery held answers `503` and comes back later.
 */
const holdMs = 120_000;

function parsePayload(body: Uint8Array) {
  try {
    const parsed = WebhookPayload.safeParse(JSON.parse(decoder.decode(body)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

type Payload = z.infer<typeof WebhookPayload>;
type Linked = Awaited<ReturnType<Store["linksTo"]>>[number];

/**
 * How long after Rondyr received a message of unknown origin the route asks
 * Rondyr to try again while a linked form has a pending queue entry. Rondyr
 * retries after 1 and 5 minutes; the queue replays a lost `202` after 1 and 5
 * minutes too.
 */
const originWaitMs = 15 * 60_000;

/** A recipient address and the EmDash form it was taken from, for the log. */
interface Recipient {
  readonly to: string;
  readonly slug: string;
}

/**
 * Who gets the emails of an accepted message, and the layout they use.
 * `originPending` means the origin is unknown while a pending queue entry of
 * a linked form may be this message: its `202` is not recorded yet.
 */
interface Audience {
  readonly layout: FormLayout | null;
  readonly recipients: readonly Recipient[];
  readonly originPending: boolean;
}

/** Every recipient of these forms, each address once ignoring case, with its first spelling. */
function uniqueRecipients(links: readonly Linked[]): Recipient[] {
  const seen = new Set<string>();
  const recipients: Recipient[] = [];
  for (const { slug, link } of links) {
    for (const to of link.recipients) {
      const key = to.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      recipients.push({ to, slug });
    }
  }
  return recipients;
}

/**
 * The address of an entry of `DeliveryRecord.sent`: a lowercase address, or
 * `<slug>:<address>` in a record written before. An address has no colon.
 */
function sentAddress(key: string): string {
  return key.slice(key.lastIndexOf(":") + 1).toLowerCase();
}

/**
 * The EmDash form a message came from is the one the queue recorded with
 * Rondyr's submission ID, when it is still linked to the message's Rondyr
 * form: its recipients and its layout. Otherwise the origin is unknown: every
 * recipient of the linked forms, and the layout of the first linked form by
 * slug that has one. With a single linked form, both give that form.
 */
async function audienceOf(store: Store, payload: Payload, now: number): Promise<Audience> {
  const links = (await store.linksTo(payload.form.id)).toSorted((left, right) =>
    left.slug < right.slug ? -1 : 1,
  );
  const originLink = async () => {
    const origin = await store.origin(payload.submission.id);
    return links.find(({ slug }) => slug === origin?.formSlug) ?? null;
  };
  const fromOrigin = async (linked: Linked): Promise<Audience> => ({
    layout: await store.layout(linked.slug),
    recipients: uniqueRecipients([linked]),
    originPending: false,
  });

  const origin = await originLink();
  if (origin !== null) return fromOrigin(origin);
  let originPending = false;
  if (
    links.length > 1 &&
    now - Date.parse(payload.submission.receivedAt) < originWaitMs &&
    (await store.hasPendingEntry(links.map(({ slug }) => slug)))
  ) {
    // Read again: an attempt records the origin before it deletes its entry.
    const recorded = await originLink();
    if (recorded !== null) return fromOrigin(recorded);
    originPending = true;
  }
  let layout: FormLayout | null = null;
  for (const { slug } of links) {
    layout = await store.layout(slug);
    if (layout !== null) break;
  }
  return { layout, recipients: uniqueRecipients(links), originPending };
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
 * over exactly what Rondyr signed. The delivery ID is the payload's
 * `deliveryId`, which the signature covers and which equals the
 * `Rondyr-Delivery-Id` header.
 *
 * `submission.accepted` sends one email per recipient address of the EmDash
 * form the message came from, or of every EmDash form linked to the Rondyr
 * form when its origin is unknown (see `audienceOf`). The request first holds
 * the delivery with a conditional write, so two requests for one delivery
 * never email at the same time, and records each address as soon as the
 * mailer took its email. The route answers `2xx` only once the mailer took
 * every email: otherwise Rondyr retries, and the addresses already emailed are
 * skipped.
 */
export async function receiveWebhook(
  ctx: WebhookHost,
  webhookSecrets: readonly string[],
  now: number,
): Promise<WebhookOutcome> {
  if (webhookSecrets.length === 0) return { status: 503, code: "NOT_CONFIGURED" };
  const verdicts = await Promise.all(
    webhookSecrets.map((secret) => verifyWebhook(ctx.input, ctx.request.headers, secret, now)),
  );
  if (!verdicts.includes("valid")) {
    const code = verdicts.includes("stale-timestamp") ? "stale-timestamp" : "invalid-signature";
    return { status: 401, code };
  }
  const payload = parsePayload(ctx.input);
  if (payload === null) return { status: 400, code: "UNKNOWN_PAYLOAD" };
  if (payload.type === "test") return { status: 200, emailed: 0 };

  const store = new Store(ctx);
  const audience = await audienceOf(store, payload, now);
  const email = ctx.email;
  if (email === undefined && audience.recipients.length > 0) {
    return { status: 503, code: "EMAIL_NOT_CONFIGURED" };
  }

  const previous = await store.delivery(payload.deliveryId);
  if (previous?.value.done === true) return { status: 200, emailed: 0 };
  if (audience.originPending) return { status: 503, code: "ORIGIN_PENDING" };
  if (previous !== null && previous.value.heldUntil > now) {
    return { status: 503, code: "DELIVERY_IN_PROGRESS" };
  }
  let record: DeliveryRecord = {
    ...(previous?.value ?? { receivedAt: now, sent: [], done: false }),
    heldUntil: now + holdMs,
  };
  let revision = await store.writeDelivery(payload.deliveryId, previous?.revision ?? null, record);
  if (revision === null) return { status: 503, code: "DELIVERY_IN_PROGRESS" };

  const { layout } = audience;
  const { subject, text } = formatNotification(
    layout,
    payload.form.name,
    payload.submission.fields,
    payload.submission.receivedAt,
  );
  const replyTo = replyToAddress(layout, payload.submission.fields);
  const sent = new Set(record.sent.map(sentAddress));
  let emailed = 0;
  let failed = false;
  for (const { to, slug } of audience.recipients) {
    const key = to.toLowerCase();
    if (sent.has(key) || email === undefined) continue;
    try {
      const message: EmailMessage = { to, subject, text };
      if (replyTo !== null) message.replyTo = replyTo;
      await email.send(message);
    } catch {
      failed = true;
      ctx.log.error("Failed to send a Rondyr notification", {
        deliveryId: payload.deliveryId,
        form: slug,
      });
      continue;
    }
    emailed += 1;
    sent.add(key);
    record = { ...record, sent: [...record.sent, key] };
    revision = await store.writeDelivery(payload.deliveryId, revision, record);
    // Another request took the delivery over after the hold ended: it sends the rest.
    if (revision === null) return { status: 503, code: "DELIVERY_IN_PROGRESS" };
  }
  record = { ...record, done: !failed, heldUntil: 0 };
  revision = await store.writeDelivery(payload.deliveryId, revision, record);
  if (revision === null) return { status: 503, code: "DELIVERY_IN_PROGRESS" };
  if (failed) return { status: 503, code: "EMAIL_FAILED" };
  return { status: 200, emailed };
}
