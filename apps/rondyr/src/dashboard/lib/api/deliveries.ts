import { mutationOptions, queryOptions } from "@tanstack/react-query";
import { Schema } from "effect";

import { DeliveryRecord } from "@rondyr/deliveries/history";

import { messagesKey } from "./messages.ts";
import { keepReadTime } from "./cache.ts";
import { organizationPath, requestJson } from "./request.ts";

/** A delivery of a message to one destination, with its attempts. */
export type DeliveryRecord = typeof DeliveryRecord.Type;

const Deliveries = Schema.Array(DeliveryRecord);

/** The deliveries of a message and their attempts. Refresh reads them again with the list. */
export function deliveriesQuery(organizationId: string, submissionId: string) {
  return queryOptions({
    queryKey: [...messagesKey(organizationId), submissionId, "deliveries"] as const,
    queryFn: ({ signal }) =>
      requestJson(
        organizationPath(organizationId, "submissions", submissionId, "deliveries"),
        Deliveries,
        { signal },
      ),
  });
}

/** Retries a failed delivery. The API answers with the deliveries of the message. */
export function retryDeliveryMutation(organizationId: string, submissionId: string) {
  return mutationOptions({
    mutationFn: (deliveryId: DeliveryRecord["id"]) =>
      requestJson(
        organizationPath(
          organizationId,
          "submissions",
          submissionId,
          "deliveries",
          deliveryId,
          "retry",
        ),
        Deliveries,
        { method: "POST" },
      ),
    onSuccess: (deliveries, _delivery, _context, { client }) =>
      client.setQueryData(
        deliveriesQuery(organizationId, submissionId).queryKey,
        deliveries,
        keepReadTime(client, deliveriesQuery(organizationId, submissionId).queryKey),
      ),
  });
}
