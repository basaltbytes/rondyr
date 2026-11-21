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

/** A Rondyr webhook delivery: the recipients already emailed, and whether it is done. */
export const DeliveryRecord = z.object({
  receivedAt: z.number().int(),
  sent: z.array(z.string()),
  done: z.boolean(),
});
export type DeliveryRecord = z.infer<typeof DeliveryRecord>;

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
} satisfies PluginStorageConfig;

/** The flat indexes, which is all a descriptor declares. */
export const descriptorStorage = {
  queue: { indexes: ["state", "formSlug", "nextAttemptAt"] },
  layouts: { indexes: [] },
  links: { indexes: ["rondyrFormId"] },
  deliveries: { indexes: ["receivedAt"] },
} satisfies PluginStorageConfig;

/** The storage operations the plugin uses. */
export type Collection = Pick<
  StorageCollection,
  "get" | "put" | "delete" | "query" | "count" | "deleteMany"
>;

/** What the store needs from a plugin context: its collections and its logger. */
export interface StorageHost {
  readonly storage: Readonly<Record<string, Collection>>;
  readonly log: Pick<PluginContext["log"], "info" | "warn" | "error">;
}

/**
 * Typed access to the plugin's storage. Every read goes through its schema: a
 * row that no longer decodes is treated as absent and logged by ID only.
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

  async #get<T>(name: keyof typeof storageConfig, schema: z.ZodType<T>, id: string) {
    const row = await this.#collection(name).get(id);
    if (row === null) return null;
    const parsed = schema.safeParse(row);
    if (parsed.success) return parsed.data;
    this.#ctx.log.warn("Stored row does not decode", { collection: name, id });
    return null;
  }

  queueEntry(id: string) {
    return this.#get("queue", QueueEntry, id);
  }

  putQueueEntry(id: string, entry: QueueEntry) {
    return this.#collection("queue").put(id, entry);
  }

  deleteQueueEntry(id: string) {
    return this.#collection("queue").delete(id);
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
    return this.#get("deliveries", DeliveryRecord, id);
  }

  putDelivery(id: string, record: DeliveryRecord) {
    return this.#collection("deliveries").put(id, record);
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
}
