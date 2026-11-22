import { z } from "astro/zod";
import type { EmailMessage, PluginContext } from "emdash";

import { autoReplyMessage, type AutoReply, type AutoReplyMessage } from "./core/auto-reply.ts";
import { declaredLayout, type DeclaredForm } from "./core/declared-forms.ts";
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
 * `autoReply` is the auto-reply that the forms plugin held for the message,
 * known only with its origin. `originPending` means the origin is unknown
 * while a pending queue entry of a linked form may be this message: its `202`
 * is not recorded yet.
 */
interface Audience {
  readonly layout: FormLayout | null;
  readonly recipients: readonly Recipient[];
  readonly autoReply: AutoReply | null;
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
 * form: its recipients, its layout and the auto-reply held for the message.
 * Otherwise the origin is unknown: every recipient of the linked forms, the
 * layout of the first linked form by slug that has one, and no auto-reply.
 * With a single linked form, both give that form's recipients and layout.
 *
 * While the origin may still be recorded, the route waits: with several linked
 * forms, for any pending entry, since the recipients depend on the form; with
 * one, for a pending entry whose locale or auto-reply requires the origin.
 */
async function audienceOf(
  store: Store,
  payload: Payload,
  now: number,
  declared: readonly DeclaredForm[],
): Promise<Audience> {
  const links = (await store.linksTo(payload.form.id)).toSorted((left, right) =>
    left.slug < right.slug ? -1 : 1,
  );
  const originOf = async () => {
    const origin = await store.origin(payload.submission.id);
    const linked = links.find(({ slug }) => slug === origin?.formSlug);
    return origin === null || linked === undefined ? null : { origin, linked };
  };
  const layoutFor = async (slug: string, locale?: string) => {
    const form = declared.find((entry) => entry.slug === slug);
    if (form !== undefined && locale !== undefined) return declaredLayout(form, locale);
    return (await store.layout(slug)) ?? (form === undefined ? null : declaredLayout(form, "en"));
  };
  const fromOrigin = async ({
    origin,
    linked,
  }: NonNullable<Awaited<ReturnType<typeof originOf>>>): Promise<Audience> => ({
    layout: await layoutFor(linked.slug, origin.locale),
    recipients: uniqueRecipients([linked]),
    // Sent already, by another delivery of the message: nothing left to send.
    autoReply: origin.autoRepliedAt === undefined ? (origin.autoReply ?? null) : null,
    originPending: false,
  });

  const known = await originOf();
  if (known !== null) return fromOrigin(known);
  let originPending = false;
  const slugs = links.map(({ slug }) => slug);
  if (
    now - Date.parse(payload.submission.receivedAt) < originWaitMs &&
    (links.length > 1
      ? await store.hasPendingEntry(slugs)
      : await store.hasPendingOriginDetails(slugs))
  ) {
    // Read again: an attempt records the origin before it deletes its entry.
    const recorded = await originOf();
    if (recorded !== null) return fromOrigin(recorded);
    originPending = true;
  }
  let layout: FormLayout | null = null;
  for (const { slug } of links) {
    layout = await layoutFor(slug);
    if (layout !== null) break;
  }
  return { layout, recipients: uniqueRecipients(links), autoReply: null, originPending };
}

/**
 * What became of a message's auto-reply in one request: `skipped` when it went
 * out already, or the message has none any more; `in-progress` while another
 * request holds it.
 */
type AutoReplyOutcome = "sent" | "skipped" | "in-progress" | "failed";

/**
 * Send a message's auto-reply unless it went out already, whatever delivery
 * asks. The request first holds it on the message's origin with a conditional
 * write, so two deliveries of one message never send it at the same time; a
 * failed send releases the hold for the next retry.
 */
async function autoReplyOnce(
  store: Store,
  submissionId: string,
  message: AutoReplyMessage,
  email: Pick<NonNullable<PluginContext["email"]>, "send">,
  now: number,
): Promise<AutoReplyOutcome> {
  const current = await store.versionedOrigin(submissionId);
  if (current === null || current.value.autoRepliedAt !== undefined) return "skipped";
  if ((current.value.autoReplyHeldUntil ?? 0) > now) return "in-progress";
  const held = await store.writeOrigin(submissionId, current.revision, {
    ...current.value,
    autoReplyHeldUntil: now + holdMs,
  });
  if (held === null) return "in-progress";
  try {
    await email.send({ ...message });
  } catch {
    await store.writeOrigin(submissionId, held, { ...current.value, autoReplyHeldUntil: 0 });
    return "failed";
  }
  await store.writeOrigin(submissionId, held, {
    ...current.value,
    autoReplyHeldUntil: 0,
    autoRepliedAt: now,
  });
  return "sent";
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
 * form when its origin is unknown (see `audienceOf`), then the auto-reply
 * that the forms plugin held for the message, to the visitor. The request
 * first holds the delivery with a conditional write, so two requests for one
 * delivery never email at the same time, and records each address, and the
 * auto-reply, as soon as the mailer took its email. The route answers `2xx`
 * only once the mailer took every email: otherwise Rondyr retries, and what
 * was already sent is skipped.
 */
export async function receiveWebhook(
  ctx: WebhookHost,
  webhookSecrets: readonly string[],
  now: number,
  declared: readonly DeclaredForm[] = [],
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
  const audience = await audienceOf(store, payload, now, declared);
  const autoReply =
    audience.autoReply === null
      ? null
      : autoReplyMessage(audience.autoReply, audience.layout, payload.submission.fields);
  const email = ctx.email;
  if (email === undefined && (audience.recipients.length > 0 || autoReply !== null)) {
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
  // The visitor's auto-reply, once per message: two deliveries of one message,
  // such as from two Rondyr webhooks to this site, send it once between them.
  if (autoReply !== null && record.autoReplied !== true && email !== undefined) {
    const outcome = await autoReplyOnce(store, payload.submission.id, autoReply, email, now);
    if (outcome === "failed") {
      failed = true;
      ctx.log.error("Failed to send a held auto-reply", { deliveryId: payload.deliveryId });
    } else if (outcome === "in-progress") {
      // Another request sends it now: Rondyr retries this delivery, which then skips it.
      await store.writeDelivery(payload.deliveryId, revision, { ...record, heldUntil: 0 });
      return { status: 503, code: "AUTO_REPLY_IN_PROGRESS" };
    } else {
      if (outcome === "sent") emailed += 1;
      record = { ...record, autoReplied: true };
      revision = await store.writeDelivery(payload.deliveryId, revision, record);
      if (revision === null) return { status: 503, code: "DELIVERY_IN_PROGRESS" };
    }
  }
  record = { ...record, done: !failed, heldUntil: 0 };
  revision = await store.writeDelivery(payload.deliveryId, revision, record);
  if (revision === null) return { status: 503, code: "DELIVERY_IN_PROGRESS" };
  if (failed) return { status: 503, code: "EMAIL_FAILED" };
  return { status: 200, emailed };
}
