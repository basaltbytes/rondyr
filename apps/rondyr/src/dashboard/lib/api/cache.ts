import type { QueryClient, QueryKey, SetDataOptions } from "@tanstack/react-query";

/**
 * The options of a write of a mutation's answer to the cache, which keep the time of the
 * last read: the answer changes what a screen shows, and the screen still reads its data
 * again when it next opens.
 */
export function keepReadTime(client: QueryClient, queryKey: QueryKey): SetDataOptions {
  const updatedAt = client.getQueryState(queryKey)?.dataUpdatedAt ?? 0;
  return updatedAt === 0 ? {} : { updatedAt };
}
