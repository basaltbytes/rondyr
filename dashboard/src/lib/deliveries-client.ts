import { Schema } from "effect";

import { DeliveryRecord } from "@rondyr/deliveries/history";

import { InboxRequestError } from "./inbox-client.ts";
import type { Inbox, Submission } from "./inbox-client.ts";

export type Delivery = typeof DeliveryRecord.Type;

const decodeDeliveries = Schema.decodeUnknownPromise(Schema.Array(DeliveryRecord));

async function send(path: string, init?: RequestInit) {
  const response = await fetch(path, init);
  if (!response.ok) throw InboxRequestError.make({ status: response.status });
  return decodeDeliveries(await response.json());
}

const deliveries = (id: Inbox["id"], submission: Submission["submissionId"]) =>
  `/api/organizations/${encodeURIComponent(id)}/submissions/${encodeURIComponent(submission)}/deliveries`;

/** The deliveries of a message and their attempts. */
export function listDeliveries(
  id: Inbox["id"],
  submission: Submission["submissionId"],
  signal: AbortSignal,
) {
  return send(deliveries(id, submission), { signal });
}

/** Retry a failed delivery, and return the deliveries of the message. */
export function retryDelivery(
  id: Inbox["id"],
  submission: Submission["submissionId"],
  delivery: Delivery["id"],
) {
  return send(`${deliveries(id, submission)}/${encodeURIComponent(delivery)}/retry`, {
    method: "POST",
  });
}
