import { z } from "astro/zod";

import type { Collection, StorageHost } from "../store.ts";

type Value = Parameters<Collection["put"]>[1];
type Query = NonNullable<Parameters<Collection["query"]>[0]>;
type Where = NonNullable<Query["where"]>;

const Document = z.record(z.string(), z.unknown());
const Range = z.object({
  lt: z.number().optional(),
  lte: z.number().optional(),
  gt: z.number().optional(),
  gte: z.number().optional(),
});
const Scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

function matches(document: Value, where: Where | undefined): boolean {
  const fields = Document.safeParse(document);
  if (!fields.success) return false;
  return Object.entries(where ?? {}).every(([key, condition]) => {
    const value = fields.data[key];
    const scalar = Scalar.safeParse(condition);
    if (scalar.success) return value === scalar.data;
    const range = Range.safeParse(condition);
    const number = z.number().safeParse(value);
    if (!range.success || !number.success) return false;
    const { lt, lte, gt, gte } = range.data;
    const n = number.data;
    return (
      (lt === undefined || n < lt) &&
      (lte === undefined || n <= lte) &&
      (gt === undefined || n > gt) &&
      (gte === undefined || n >= gte)
    );
  });
}

function sortValue(document: Value, key: string): number {
  const fields = Document.safeParse(document);
  const value = fields.success ? z.number().safeParse(fields.data[key]) : null;
  return value?.success === true ? value.data : 0;
}

interface Row {
  readonly data: Value;
  readonly revision: string;
}

/**
 * An in-memory storage collection for unit tests: equality and numeric range
 * filters, one sort key, a limit, and conditional writes on a revision that
 * changes with every write. No cursor, so every page is the only page.
 */
class MemoryCollection implements Collection {
  readonly rows = new Map<string, Row>();
  #writes = 0;

  #write(id: string, data: Value): string {
    this.#writes += 1;
    const revision = String(this.#writes);
    this.rows.set(id, { data: structuredClone(data), revision });
    return revision;
  }

  async get(id: string) {
    return this.rows.get(id)?.data ?? null;
  }

  async getVersioned(id: string) {
    const row = this.rows.get(id);
    return row === undefined ? null : { value: row.data, revision: row.revision };
  }

  async put(id: string, data: Value) {
    this.#write(id, data);
  }

  async compareAndSet(id: string, expectedRevision: string | null, data: Value) {
    const current = this.rows.get(id)?.revision ?? null;
    if (current !== expectedRevision) return { applied: false as const };
    return { applied: true as const, revision: this.#write(id, data) };
  }

  async compareAndDelete(id: string, expectedRevision: string) {
    if (this.rows.get(id)?.revision !== expectedRevision) return { applied: false };
    return { applied: this.rows.delete(id) };
  }

  async delete(id: string) {
    return this.rows.delete(id);
  }

  async deleteMany(ids: string[]) {
    return ids.filter((id) => this.rows.delete(id)).length;
  }

  async count(where?: Where) {
    return [...this.rows.values()].filter(({ data }) => matches(data, where)).length;
  }

  async query(options?: Query) {
    const [sortKey, direction] = Object.entries(options?.orderBy ?? {})[0] ?? [];
    const items = [...this.rows.entries()]
      .filter(([, { data }]) => matches(data, options?.where))
      .map(([id, { data }]) => ({ id, data }))
      .toSorted((left, right) =>
        sortKey === undefined
          ? 0
          : (sortValue(left.data, sortKey) - sortValue(right.data, sortKey)) *
            (direction === "desc" ? -1 : 1),
      )
      .slice(0, options?.limit ?? 50);
    return { items, hasMore: false };
  }
}

type LogData = Parameters<StorageHost["log"]["info"]>[1];

export interface LogLine {
  readonly level: "info" | "warn" | "error";
  readonly message: string;
  readonly data: LogData;
}

/** A storage host with the plugin's collections and a logger that records lines. */
export function memoryHost() {
  const lines: LogLine[] = [];
  const collections = {
    queue: new MemoryCollection(),
    layouts: new MemoryCollection(),
    links: new MemoryCollection(),
    deliveries: new MemoryCollection(),
    origins: new MemoryCollection(),
    unqueued: new MemoryCollection(),
  };
  const host: StorageHost = {
    storage: collections,
    log: {
      info: (message: string, data?: LogData) => lines.push({ level: "info", message, data }),
      warn: (message: string, data?: LogData) => lines.push({ level: "warn", message, data }),
      error: (message: string, data?: LogData) => lines.push({ level: "error", message, data }),
    },
  };
  return { host, collections, lines };
}
