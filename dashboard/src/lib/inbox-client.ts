import { Schema } from "effect";

import { InboxOrganizationWithForms, SetupInbox } from "@rondyr/contracts/inbox-setup";
import {
  InboxCounts,
  InboxEntry,
  InboxPage,
  SubmissionDetail,
  SubmissionStatus,
} from "@rondyr/contracts/inbox";

export type Inbox = typeof InboxOrganizationWithForms.Type;
/** A message in a page of the list. Its `preview` has every field, with long values cut short. */
export type SubmissionEntry = typeof InboxEntry.Type;
/** A message with its full fields, as the detail route and a decision return it. */
export type Submission = typeof SubmissionDetail.Type;
export type Status = typeof SubmissionStatus.Type;
export type Counts = typeof InboxCounts.Type;

export class InboxRequestError extends Schema.TaggedError<
  InboxRequestError,
  { readonly brand: unique symbol }
>()("InboxRequestError", { status: Schema.Int }) {}

async function send(path: string, init?: RequestInit) {
  const response = await fetch(path, init);
  if (!response.ok) throw InboxRequestError.make({ status: response.status });
  return response;
}

const organizations = "/api/organizations";
const submissions = (id: Inbox["id"]) => `${organizations}/${encodeURIComponent(id)}/submissions`;
const decodeInboxes = Schema.decodeUnknownPromise(Schema.Array(InboxOrganizationWithForms));
const decodePage = Schema.decodeUnknownPromise(InboxPage);
const decodeSubmission = Schema.decodeUnknownPromise(SubmissionDetail);
const decodeCounts = Schema.decodeUnknownPromise(InboxCounts);

export async function listInboxes(signal?: AbortSignal) {
  const response = await send(organizations, signal === undefined ? {} : { signal });
  return decodeInboxes(await response.json());
}

export async function createInbox(form: FormData) {
  const body = Schema.decodeUnknownSync(SetupInbox)(Object.fromEntries(form));
  await send(organizations, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function listSubmissions(
  id: Inbox["id"],
  status: Status | "",
  cursor: string | null,
  signal: AbortSignal,
) {
  const params = new URLSearchParams();
  if (status !== "") params.set("status", status);
  if (cursor !== null) params.set("after", cursor);
  const response = await send(`${submissions(id)}?${params}`, { signal });
  return decodePage(await response.json());
}

/**
 * How many messages of the organization have each status. The API reads every
 * message of the organization to count them, so ask only when the counts may
 * have changed without the dashboard knowing.
 */
export async function countSubmissions(id: Inbox["id"], signal: AbortSignal) {
  const response = await send(`${organizations}/${encodeURIComponent(id)}/submission-counts`, {
    signal,
  });
  return decodeCounts(await response.json());
}

/** A message with its full fields. */
export async function getSubmission(
  id: Inbox["id"],
  submission: Submission["submissionId"],
  signal: AbortSignal,
) {
  const response = await send(`${submissions(id)}/${encodeURIComponent(submission)}`, { signal });
  return decodeSubmission(await response.json());
}

export async function reviewSubmission(
  id: Inbox["id"],
  submission: Submission["submissionId"],
  decision: "approve" | "dismiss",
) {
  const response = await send(`${submissions(id)}/${encodeURIComponent(submission)}/${decision}`, {
    method: "POST",
  });
  return decodeSubmission(await response.json());
}
