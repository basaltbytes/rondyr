import { Schema } from "effect";

import { OperationsStatus, StuckSubmissions } from "@rondyr/contracts/operations-status";

import { InboxRequestError } from "./inbox-client.ts";
import type { Inbox, Submission } from "./inbox-client.ts";

/** The stuck submissions of an organization, oldest first, and how many there are. */
export type Stuck = typeof StuckSubmissions.Type;

const decode = Schema.decodeUnknownPromise(OperationsStatus);
const decodeStuck = Schema.decodeUnknownPromise(StuckSubmissions);

export async function readOperationsStatus() {
  const response = await fetch("/api/operations");
  if (!response.ok) throw InboxRequestError.make({ status: response.status });
  return decode(await response.json());
}

const stuckPath = (id: Inbox["id"]) =>
  `/api/organizations/${encodeURIComponent(id)}/stuck-submissions`;

async function sendStuck(path: string, init?: RequestInit) {
  const response = await fetch(path, init);
  if (!response.ok) throw InboxRequestError.make({ status: response.status });
  return decodeStuck(await response.json());
}

/** The submissions of an organization that the Cron no longer publishes. */
export function listStuck(id: Inbox["id"], signal: AbortSignal) {
  return sendStuck(stuckPath(id), { signal });
}

/** Publish a stuck submission again, and return the stuck submissions left. */
export function retryStuck(id: Inbox["id"], submission: Submission["submissionId"]) {
  return sendStuck(`${stuckPath(id)}/${encodeURIComponent(submission)}/retry`, {
    method: "POST",
  });
}
