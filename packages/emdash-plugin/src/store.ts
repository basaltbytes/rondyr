import { z } from "astro/zod";
import type { PluginContext, PluginStorageConfig, StorageCollection } from "emdash";

import { FormLayout } from "./core/fields.ts";
import { QueueEntry, type QueueState } from "./core/queue.ts";

type Where = NonNullable<NonNullable<Parameters<StorageCollection["query"]>[0]>["where"]>;

/** The Rondyr form and the notification recipients of an EmDash form. */
export const FormLink = z.object({
  rondyrFormId: z.string().min(1).max(128).nullable(),
  recipients: z.array(z.email()).max(20),
});
export type FormLink = z.infer<typeof FormLink>;

/**
 * A Rondyr webhook delivery: the recipients already emailed, whether it is
 * done, and until when a request that is sending its emails holds it.
 */
export const DeliveryRecord = z.object({
  receivedAt: z.number().int(),
  sent: z.array(z.string()),
  done: z.boolean(),
  heldUntil: z.number().int().default(0),
});
export type DeliveryRecord = z.infer<typeof DeliveryRecord>;

/**
 * Submissions of an EmDash form that the forms plugin accepted but that could
 * not be put in the queue: how many, and when the first and the last happened.
 */
export const UnqueuedRecord = z.object({
  count: z.number().int().min(1),
  firstAt: z.number().int(),
  lastAt: z.number().int(),
});
export type UnqueuedRecord = z.infer<typeof UnqueuedRecord>;

/** Storage collections and indexes, for the descriptor and for the plugin. */
export const storageConfig = {
  queue: {
    indexes: [
      "state",
      "formSlug",
      "nextAttemptAt",
      ["state", "nextAttemptAt"],
      ["state", "formSlug"],
    ],
  },
  layouts: { indexes: [] },
  links: { indexes: ["rondyrFormId"] },
  deliveries: { indexes: ["receivedAt"] },
  unqueued: { indexes: [] },
} satisfies PluginStorageConfig;

/** The flat indexes, which is all a descriptor declares. */
export const descriptorStorage = {
  queue: { indexes: ["state", "formSlug", "nextAttemptAt"] },
  layouts: { indexes: [] },
  links: { indexes: ["rondyrFormId"] },
  deliveries: { indexes: ["receivedAt"] },
  unqueued: { indexes: [] },
} satisfies PluginStorageConfig;

/** The storage operations the plugin uses. */
export type Collection = Pick<
  StorageCollection,
  | "get"
  | "put"
  | "delete"
  | "query"
  | "count"
  | "deleteMany"
  | "getVersioned"
  | "compareAndSet"
  | "compareAndDelete"
>;

/** What the store needs from a plugin context: its collections and its logger. */
export interface StorageHost {
  readonly storage: Readonly<Record<string, Collection>>;
  readonly log: Pick<PluginContext["log"], "info" | "warn" | "error">;
}

/** A row and the revision it was read at, for a conditional write. */
export interface Versioned<T> {
  readonly value: T;
  readonly revision: string;
}

/** How many times a counter update is tried again after a concurrent write. */
const casAttempts = 5;

/**
 * Typed access to the plugin's storage. Every read goes through its schema: a
 * row that no longer decodes is treated as absent and logged by ID only.
 * Writes that race with another request are conditional on the revision read.
 */
export class Store {
  readonly #ctx: StorageHost;

  constructor(ctx: StorageHost) {
    this.#ctx = ctx;
  }

  #collection(name: keyof typeof storageConfig): Collection {
    const collection = this.#ctx.storage[name];
    if (collection === undefined) throw new Error(`Storage collection ${name} is not declared`);
    return collection;
  }

  #decoded<T>(name: keyof typeof storageConfig, id: string, parsed: z.ZodSafeParseResult<T>) {
    if (parsed.success) return parsed.data;
    this.#ctx.log.warn("Stored row does not decode", { collection: name, id });
    return null;
  }

  async #get<T>(name: keyof typeof storageConfig, schema: z.ZodType<T>, id: string) {
    const row = await this.#collection(name).get(id);
    return row === null ? null : this.#decoded(name, id, schema.safeParse(row));
  }

  async #getVersioned<T>(
    name: keyof typeof storageConfig,
    schema: z.ZodType<T>,
    id: string,
  ): Promise<Versioned<T> | null> {
    const row = await this.#collection(name).getVersioned(id);
    if (row === null) return null;
    const value = this.#decoded(name, id, schema.safeParse(row.value));
    return value === null ? null : { value, revision: row.revision };
  }

  queueEntry(id: string) {
    return this.#get("queue", QueueEntry, id);
  }

  versionedQueueEntry(id: string) {
    return this.#getVersioned("queue", QueueEntry, id);
  }

  /** Store a new entry, unless one exists under this ID. Returns whether it was stored. */
  async createQueueEntry(id: string, entry: QueueEntry): Promise<boolean> {
    const result = await this.#collection("queue").compareAndSet(id, null, entry);
    return result.applied;
  }

  /** Replace an entry read at `revision`. Returns the new revision, or null after a concurrent write. */
  async replaceQueueEntry(id: string, revision: string, entry: QueueEntry) {
    const result = await this.#collection("queue").compareAndSet(id, revision, entry);
    return result.applied ? result.revision : null;
  }

  /** Delete an entry read at `revision`. Returns false after a concurrent write. */
  async deleteQueueEntry(id: string, revision: string): Promise<boolean> {
    const result = await this.#collection("queue").compareAndDelete(id, revision);
    return result.applied;
  }

  /** Queue entries in a state, oldest attempt first, at most `limit`. */
  async queueEntries(
    state: QueueState,
    limit: number,
    dueBy: number | null,
    formSlug: string | null,
  ) {
    const where: Where = { state };
    if (dueBy !== null) where.nextAttemptAt = { lte: dueBy };
    if (formSlug !== null) where.formSlug = formSlug;
    const page = await this.#collection("queue").query({
      where,
      orderBy: { nextAttemptAt: "asc" },
      limit,
    });
    return page.items.flatMap(({ id, data }) => {
      const parsed = QueueEntry.safeParse(data);
      return parsed.success ? [{ id, entry: parsed.data }] : [];
    });
  }

  queueCount(state: QueueState) {
    return this.#collection("queue").count({ state });
  }

  layout(slug: string) {
    return this.#get("layouts", FormLayout, slug);
  }

  putLayout(layout: FormLayout) {
    return this.#collection("layouts").put(layout.slug, layout);
  }

  link(slug: string) {
    return this.#get("links", FormLink, slug);
  }

  putLink(slug: string, link: FormLink) {
    return this.#collection("links").put(slug, link);
  }

  async links() {
    const page = await this.#collection("links").query({ limit: 100 });
    return page.items.flatMap(({ id, data }) => {
      const parsed = FormLink.safeParse(data);
      return parsed.success ? [{ slug: id, link: parsed.data }] : [];
    });
  }

  /** The EmDash forms linked to a Rondyr form, by slug. */
  async linksTo(rondyrFormId: string) {
    const page = await this.#collection("links").query({ where: { rondyrFormId }, limit: 100 });
    return page.items.flatMap(({ id, data }) => {
      const parsed = FormLink.safeParse(data);
      return parsed.success ? [{ slug: id, link: parsed.data }] : [];
    });
  }

  delivery(id: string) {
    return this.#getVersioned("deliveries", DeliveryRecord, id);
  }

  /**
   * Write a delivery record read at `revision`, or create it when `revision`
   * is null. Returns the new revision, or null after a concurrent write.
   */
  async writeDelivery(id: string, revision: string | null, record: DeliveryRecord) {
    const result = await this.#collection("deliveries").compareAndSet(id, revision, record);
    return result.applied ? result.revision : null;
  }

  /** Forget delivery IDs older than `before`. Rondyr stops retrying long before. */
  async forgetDeliveries(before: number) {
    const page = await this.#collection("deliveries").query({
      where: { receivedAt: { lt: before } },
      limit: 100,
    });
    const ids = page.items.map(({ id }) => id);
    if (ids.length > 0) await this.#collection("deliveries").deleteMany(ids);
  }

  /** Count a submission of `slug` that could not be queued. */
  async recordUnqueued(slug: string, now: number): Promise<void> {
    for (let attempt = 0; attempt < casAttempts; attempt += 1) {
      const current = await this.#getVersioned("unqueued", UnqueuedRecord, slug);
      const next: UnqueuedRecord =
        current === null
          ? { count: 1, firstAt: now, lastAt: now }
          : { ...current.value, count: current.value.count + 1, lastAt: now };
      const result = await this.#collection("unqueued").compareAndSet(
        slug,
        current?.revision ?? null,
        next,
      );
      if (result.applied) return;
    }
    throw new Error("The unqueued count kept changing");
  }

  async unqueued() {
    const page = await this.#collection("unqueued").query({ limit: 100 });
    return page.items.flatMap(({ id, data }) => {
      const parsed = UnqueuedRecord.safeParse(data);
      return parsed.success ? [{ slug: id, record: parsed.data }] : [];
    });
  }

  async clearUnqueued(slug: string): Promise<void> {
    await this.#collection("unqueued").delete(slug);
  }
}
