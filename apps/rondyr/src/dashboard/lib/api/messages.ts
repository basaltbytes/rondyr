import {
  infiniteQueryOptions,
  mutationOptions,
  queryOptions,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import { Option, Schema } from "effect";

import {
  InboxCounts,
  InboxEntry,
  InboxPage,
  InboxRow,
  OrganizationCounts,
  SubmissionDetail,
  SubmissionStatus,
} from "@rondyr/contracts/inbox";

import { countsAfterMove, countsAfterRemoval } from "~/lib/folder-counts";
import { MessagesSearch } from "~/lib/messages-search";

import { keepReadTime } from "./cache.ts";
import { organizationPath, request, requestJson, statusOf } from "./request.ts";

/** A message in a page of the list. Its `preview` has every field, with long values cut short. */
export type InboxEntry = typeof InboxEntry.Type;
/** A message with its full fields, as the detail route and a decision return it. */
export type SubmissionDetail = typeof SubmissionDetail.Type;
/** What a message of the list and an open message share: everything but the fields. */
export type InboxRow = typeof InboxRow.Type;
export type SubmissionStatus = typeof SubmissionStatus.Type;
/** How many messages have each status. */
export type InboxCounts = typeof InboxCounts.Type;
/** The counts of an organization, and those of each of its forms that has a message. */
export type OrganizationCounts = typeof OrganizationCounts.Type;
export type InboxPage = typeof InboxPage.Type;

type Decision = "approve" | "dismiss" | "reclassify";

const decodeSearch = Schema.decodeUnknownOption(MessagesSearch);

/** The query of the API for a list: the status, the form and the search. */
function listParams({ folder, form, q }: MessagesSearch) {
  const params = new URLSearchParams();
  if (folder !== "all") params.set("status", folder);
  if (form !== undefined) params.set("form", form);
  if (q !== undefined) params.set("q", q);
  return params;
}

/** Every query of the messages of an organization: lists, messages and their deliveries. */
export function messagesKey(organizationId: string) {
  return [organizationId, "messages"] as const;
}

function listsKey(organizationId: string) {
  return [...messagesKey(organizationId), "list"] as const;
}

const firstPage: string | null = null;

/**
 * The messages of a folder, of one form or of all, with a text or not, a page at a time.
 * Each page gives the cursor of the next one.
 */
export function messageListQuery(organizationId: string, search: MessagesSearch) {
  // The router keeps every param of the address; the list depends on these three.
  const filter: MessagesSearch = { folder: search.folder, form: search.form, q: search.q };
  return infiniteQueryOptions({
    queryKey: [...listsKey(organizationId), filter] as const,
    queryFn: ({ pageParam, signal }) => {
      const params = listParams(search);
      if (pageParam !== null) params.set("after", pageParam);
      const path = `${organizationPath(organizationId, "submissions")}?${params}`;
      return requestJson(path, InboxPage, { signal });
    },
    initialPageParam: firstPage,
    getNextPageParam: (page) => page.cursor,
  });
}

/** A message with its full fields. A list entry has long values cut short. */
export function messageQuery(organizationId: string, submissionId: string) {
  return queryOptions({
    queryKey: [...messagesKey(organizationId), submissionId] as const,
    queryFn: ({ signal }) =>
      requestJson(organizationPath(organizationId, "submissions", submissionId), SubmissionDetail, {
        signal,
      }),
  });
}

/**
 * How many messages of the organization and of each of its forms have each status. The
 * API reads every message of the organization to count them, so a decision and a deletion
 * move the counts in the cache, and only Refresh, a reload and a change of organization
 * read them again.
 */
export function messageCountsQuery(organizationId: string) {
  return queryOptions({
    queryKey: [organizationId, "message-counts"] as const,
    queryFn: ({ signal }) =>
      requestJson(organizationPath(organizationId, "submission-counts"), OrganizationCounts, {
        signal,
      }),
    staleTime: Number.POSITIVE_INFINITY,
    // The folders work without their counts, and a sidebar that opens tries again.
    retryOnMount: true,
  });
}

/** Reads the lists, the open message, its deliveries and the counts again. */
export async function refreshMessages(client: QueryClient, organizationId: string) {
  await Promise.all([
    client.invalidateQueries({ queryKey: messagesKey(organizationId) }),
    client.invalidateQueries({ queryKey: messageCountsQuery(organizationId).queryKey }),
  ]);
}

/**
 * The address of an export of a list, which the browser downloads with the session
 * cookie. The API sends at most the 10,000 newest messages.
 */
export function exportAddress(
  organizationId: string,
  format: "csv" | "jsonl",
  search: MessagesSearch,
) {
  const params = listParams(search);
  params.set("format", format);
  return `${organizationPath(organizationId, "submission-export")}?${params}`;
}

type Pages = InfiniteData<InboxPage, string | null>;

/** Changes the entries of every cached list of the organization. */
function changeLists(
  client: QueryClient,
  organizationId: string,
  change: (entries: ReadonlyArray<InboxEntry>, search: MessagesSearch) => ReadonlyArray<InboxEntry>,
) {
  for (const query of client.getQueryCache().findAll({ queryKey: listsKey(organizationId) })) {
    const search = decodeSearch(query.queryKey[3]);
    if (Option.isNone(search)) continue;
    client.setQueryData<Pages>(
      query.queryKey,
      (pages) =>
        pages === undefined
          ? undefined
          : {
              ...pages,
              pages: pages.pages.map((page) => ({
                ...page,
                entries: change(page.entries, search.value),
              })),
            },
      keepReadTime(client, query.queryKey),
    );
  }
}

/** What the cache knows of a message before a decision or a deletion. */
export type DecidedFrom = Pick<InboxRow, "submissionId" | "formPublicId" | "status">;

/**
 * Applies a decision to the cache, so it asks the API for nothing: the message takes its
 * new status in the lists that keep it and leaves the others, and the counts follow.
 */
export function applyDecision(
  client: QueryClient,
  organizationId: string,
  before: DecidedFrom,
  updated: SubmissionDetail,
) {
  client.setQueryData(
    messageQuery(organizationId, updated.submissionId).queryKey,
    updated,
    keepReadTime(client, messageQuery(organizationId, updated.submissionId).queryKey),
  );
  changeLists(client, organizationId, (entries, { folder }) =>
    folder === "all" || folder === updated.status
      ? entries.map((entry) =>
          entry.submissionId === updated.submissionId
            ? { ...entry, status: updated.status, reason: updated.reason, label: updated.label }
            : entry,
        )
      : entries.filter((entry) => entry.submissionId !== updated.submissionId),
  );
  client.setQueryData(
    messageCountsQuery(organizationId).queryKey,
    (counts) =>
      counts === undefined
        ? undefined
        : countsAfterMove(counts, before.formPublicId, before.status, updated.status),
    keepReadTime(client, messageCountsQuery(organizationId).queryKey),
  );
}

/**
 * Accept or archive a quarantined message, or send one that the classifier could not
 * analyze back to classification.
 */
export function reviewMessage(organizationId: string, submissionId: string, decision: Decision) {
  return requestJson(
    organizationPath(organizationId, "submissions", submissionId, decision),
    SubmissionDetail,
    { method: "POST" },
  );
}

export function reviewMessageMutation(organizationId: string) {
  return mutationOptions({
    mutationFn: ({ message, decision }: { message: DecidedFrom; decision: Decision }) =>
      reviewMessage(organizationId, message.submissionId, decision),
    onSuccess: (updated, { message }, _context, { client }) =>
      applyDecision(client, organizationId, message, updated),
  });
}

/**
 * Delete a message, its deliveries and their attempts, for good. A message that another
 * admin deleted first is gone either way.
 */
export async function deleteMessage(organizationId: string, submissionId: string) {
  try {
    await request(organizationPath(organizationId, "submissions", submissionId), {
      method: "DELETE",
    });
  } catch (cause) {
    if (statusOf(cause) !== 404) throw cause;
  }
}

/** Deletes a message, then takes it out of the cached lists and counts. */
export function deleteMessageMutation(organizationId: string) {
  return mutationOptions({
    mutationFn: (message: DecidedFrom) => deleteMessage(organizationId, message.submissionId),
    onSuccess: (_deleted, message, _context, { client }) => {
      changeLists(client, organizationId, (entries) =>
        entries.filter((entry) => entry.submissionId !== message.submissionId),
      );
      client.setQueryData(
        messageCountsQuery(organizationId).queryKey,
        (counts) =>
          counts === undefined
            ? undefined
            : countsAfterRemoval(counts, message.formPublicId, message.status),
        keepReadTime(client, messageCountsQuery(organizationId).queryKey),
      );
      client.removeQueries({
        queryKey: messageQuery(organizationId, message.submissionId).queryKey,
      });
    },
  });
}
