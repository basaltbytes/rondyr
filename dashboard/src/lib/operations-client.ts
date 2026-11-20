import { Schema } from "effect";

import { OperationsStatus } from "@rondyr/contracts/operations-status";

import { InboxRequestError } from "./inbox-client.ts";

const decode = Schema.decodeUnknownPromise(OperationsStatus);

export async function readOperationsStatus() {
  const response = await fetch("/api/operations");
  if (!response.ok) throw InboxRequestError.make({ status: response.status });
  return decode(await response.json());
}
