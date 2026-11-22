import { z } from "astro/zod";
import type {
  EmailMessage,
  PluginContext,
  PluginRoute,
  ResolvedPlugin,
  RouteContext,
  StorageCollection,
} from "emdash";

import { AutoReply } from "./core/auto-reply.ts";
import { claimHandoff, handoffHeader, type Handoff } from "./handoff.ts";

/**
 * The forms plugin's `submit` and its daily digest, made aware of Rondyr.
 *
 * A submission that the site route hands over (see `handoff.ts`) runs the
 * forms plugin's own handler, which validates and stores it as before, with an
 * email access that holds what the handler sends: its notification and its
 * auto-reply. The site route then settles them. When the Rondyr plugin queued
 * the submission for a linked form, the held emails are dropped: Rondyr's
 * recipients get the message once Rondyr accepts it, and the auto-reply, which
 * is reported to the site route, goes to the visitor at the same moment.
 * Otherwise the held emails go out as the forms plugin wrote them.
 *
 * A submission posted straight to the forms plugin's own route keeps every
 * email. It is counted, so that the Rondyr settings page can say that Rondyr
 * doesn't have it.
 *
 * The daily digest leaves out the submissions whose emails were dropped. The
 * forms plugin finds those with `storage.submissions.query`, so the digest's
 * context gets a collection that skips them.
 */

type EmailAccess = NonNullable<PluginContext["email"]>;
type CronHandler = NonNullable<ResolvedPlugin["hooks"]["cron"]>["handler"];

/** KV keys of the forms plugin's own namespace that this package writes. */
const handledPrefix = "rondyr:handled:";
const bypassedPrefix = "rondyr:bypassed:";

/** The forms plugin names the cron task of a form's digest `digest-<form ID>`. */
const digestPrefix = "digest-";

/** A digest covers the last day; a mark older than two days is no longer read. */
const markMemoryMs = 2 * 24 * 3_600_000;

/** How many times a counter update is tried again after a concurrent write. */
const casAttempts = 5;

/** The parts of a stored form that the handoff reads. */
const StoredForm = z.object({
  settings: z.object({
    digestEnabled: z.boolean().optional(),
    autoresponder: z.object({ subject: z.string() }).nullish(),
  }),
});
type StoredForm = z.infer<typeof StoredForm>;

/** The part of a stored submission that the handoff reads: the ID of its form. */
const StoredSubmission = z.object({ formId: z.string().min(1).max(200) });

const SubmitInput = z.object({ formId: z.string() });

const HandledMark = z.object({ at: z.number().int() });

/** Submissions of a form posted straight to the forms plugin: how many, and when. */
export const BypassedRecord = z.object({
  count: z.number().int().min(1),
  firstAt: z.number().int(),
  lastAt: z.number().int(),
});
export type BypassedRecord = z.infer<typeof BypassedRecord>;

const ClearInput = z.object({ formId: z.string().min(1).max(200) });

/**
 * A collection that passes every call to `collection`, except the ones in
 * `overrides`. Every method is listed, so a method that a later EmDash adds to
 * `StorageCollection` fails the type check here instead of going unobserved.
 */
function delegating(
  collection: StorageCollection,
  overrides: Pick<StorageCollection, "put" | "putMany" | "query">,
): StorageCollection {
  return {
    get: (id) => collection.get(id),
    delete: (id) => collection.delete(id),
    exists: (id) => collection.exists(id),
    getVersioned: (id) => collection.getVersioned(id),
    compareAndSet: (id, revision, data) => collection.compareAndSet(id, revision, data),
    compareAndDelete: (id, revision) => collection.compareAndDelete(id, revision),
    getMany: (ids) => collection.getMany(ids),
    deleteMany: (ids) => collection.deleteMany(ids),
    count: (where) => collection.count(where),
    updateIf: (id, update) => collection.updateIf(id, update),
    ...overrides,
  };
}

/** A submission that the forms plugin stored, and the form it belongs to. */
interface Stored {
  readonly id: string;
  readonly formId: string;
}

/** A collection that reports each submission the forms plugin stores in it. */
function reportingPuts(
  collection: StorageCollection,
  onStored: (stored: Stored) => void,
): StorageCollection {
  return delegating(collection, {
    put: async (id, data) => {
      await collection.put(id, data);
      const parsed = StoredSubmission.safeParse(data);
      if (parsed.success) onStored({ id, formId: parsed.data.formId });
    },
    putMany: async (items) => {
      await collection.putMany(items);
      for (const { id, data } of items) {
        const parsed = StoredSubmission.safeParse(data);
        if (parsed.success) onStored({ id, formId: parsed.data.formId });
      }
    },
    query: (options) => collection.query(options),
  });
}

/** A collection whose queries leave out the submissions in `skipped`. */
function skipping(collection: StorageCollection, skipped: ReadonlySet<string>): StorageCollection {
  return delegating(collection, {
    put: (id, data) => collection.put(id, data),
    putMany: (items) => collection.putMany(items),
    query: async (options) => {
      const limit = options?.limit ?? 50;
      const items: Awaited<ReturnType<StorageCollection["query"]>>["items"] = [];
      let cursor = options?.cursor;
      for (let page = 0; page < 20; page += 1) {
        const result = await collection.query({ ...options, limit, cursor });
        items.push(...result.items.filter(({ id }) => !skipped.has(id)));
        cursor = result.cursor;
        if (items.length >= limit || cursor === undefined || !result.hasMore) break;
      }
      return { items: items.slice(0, limit), hasMore: false };
    },
  });
}

/** The form a submission names, by ID or by slug, as the forms plugin looks it up. */
async function findForm(
  forms: StorageCollection | undefined,
  formId: string,
): Promise<StoredForm | null> {
  if (forms === undefined) return null;
  const byId: unknown = await forms.get(formId);
  const found =
    byId ?? (await forms.query({ where: { slug: formId }, limit: 1 })).items[0]?.data ?? null;
  const parsed = StoredForm.safeParse(found);
  return parsed.success ? parsed.data : null;
}

/** The submissions stored by one call of the forms plugin's handler, and the storage it gets. */
function storedSubmissions(ctx: PluginContext) {
  const stored: Stored[] = [];
  const submissions = ctx.storage["submissions"];
  const storage =
    submissions === undefined
      ? ctx.storage
      : { ...ctx.storage, submissions: reportingPuts(submissions, (row) => stored.push(row)) };
  return { stored, storage };
}

/** Count a submission posted straight to the forms plugin. Never throws. */
async function countBypassed(ctx: PluginContext, formId: string, now: number): Promise<void> {
  const key = `${bypassedPrefix}${formId}`;
  try {
    for (let attempt = 0; attempt < casAttempts; attempt += 1) {
      const current = await ctx.kv.getVersioned<unknown>(key);
      const record = BypassedRecord.safeParse(current?.value);
      const next: BypassedRecord = record.success
        ? { ...record.data, count: record.data.count + 1, lastAt: now }
        : { count: 1, firstAt: now, lastAt: now };
      const result = await ctx.kv.compareAndSet(key, current?.revision ?? null, next);
      if (result.applied) return;
    }
    ctx.log.warn("A submission posted to the Forms plugin could not be counted", { formId });
  } catch (error) {
    ctx.log.warn("A submission posted to the Forms plugin could not be counted", {
      formId,
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

/**
 * The submissions of a form whose emails were dropped in the last two days,
 * for its digest. Older marks are deleted on the way.
 */
async function handledSubmissions(ctx: PluginContext, formId: string, now: number) {
  const prefix = `${handledPrefix}${formId}:`;
  const handled = new Set<string>();
  for (const { key, value } of await ctx.kv.list(prefix)) {
    const mark = HandledMark.safeParse(value);
    if (mark.success && mark.data.at >= now - markMemoryMs) handled.add(key.slice(prefix.length));
    else await ctx.kv.delete(key);
  }
  return handled;
}

/** Delete the marks of every form that no digest will read again. */
async function forgetHandled(ctx: PluginContext, now: number): Promise<void> {
  for (const { key, value } of await ctx.kv.list(handledPrefix)) {
    const mark = HandledMark.safeParse(value);
    if (!mark.success || mark.data.at < now - markMemoryMs) await ctx.kv.delete(key);
  }
}

/** The held auto-reply: the forms plugin sends it with the subject set in the form. */
function heldAutoReply(form: StoredForm | null, held: readonly EmailMessage[]): AutoReply | null {
  const subject = form?.settings.autoresponder?.subject;
  if (subject === undefined) return null;
  const message = held.findLast((candidate) => candidate.subject === subject);
  if (message === undefined) return null;
  const parsed = AutoReply.safeParse({
    subject: message.subject,
    text: message.text,
    html: message.html,
  });
  return parsed.success ? parsed.data : null;
}

/** The context of a handed-over submission, and what to report once the handler returns. */
interface HandOver {
  readonly context: RouteContext;
  readonly report: () => void;
}

/**
 * The context in which the forms plugin's handler runs a handed-over
 * submission: its emails are held until the site route settles the handoff.
 */
async function handOver(ctx: RouteContext, handoff: Handoff): Promise<HandOver> {
  const { stored, storage } = storedSubmissions(ctx);
  const email = ctx.email;
  const held: EmailMessage[] = [];
  let state: "holding" | "sending" | "dropped" = "holding";
  let form: StoredForm | null = null;

  handoff.settle = async (handled) => {
    if (state !== "holding") return;
    state = handled ? "dropped" : "sending";
    const messages = held.splice(0);
    if (handled) {
      if (form?.settings.digestEnabled !== true) return;
      for (const { id, formId } of stored) {
        try {
          await ctx.kv.set(`${handledPrefix}${formId}:${id}`, { at: Date.now() });
        } catch (error) {
          // The digest then lists this submission: a duplicate, never a loss.
          ctx.log.warn("A submission sent to Rondyr could not be left out of the digest", {
            formId,
            error: error instanceof Error ? error.name : "unknown",
          });
        }
      }
      return;
    }
    for (const message of messages) {
      try {
        await email?.send(message);
      } catch (error) {
        // The error's name only: its text could carry an address.
        ctx.log.error("A Forms plugin email could not be sent", {
          error: error instanceof Error ? error.name : "unknown",
        });
      }
    }
  };

  const input = SubmitInput.safeParse(ctx.input);
  try {
    form = input.success ? await findForm(ctx.storage["forms"], input.data.formId) : null;
  } catch (error) {
    ctx.log.warn("The form of a submission could not be read for Rondyr", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }

  const holding: EmailAccess | undefined =
    email === undefined
      ? undefined
      : {
          send: async (message) => {
            if (state === "sending") return email.send(message);
            if (state === "holding") held.push(message);
          },
        };
  return {
    context: { ...ctx, storage, email: holding },
    report: () => {
      handoff.autoReply = heldAutoReply(form, held);
    },
  };
}

function submitWithHandoff(handler: PluginRoute["handler"]): PluginRoute["handler"] {
  return async (ctx: RouteContext) => {
    const handoff = claimHandoff(ctx.request.headers.get(handoffHeader));
    if (handoff !== undefined) {
      const { context, report } = await handOver(ctx, handoff);
      const result = await handler(context);
      report();
      return result;
    }
    const { stored, storage } = storedSubmissions(ctx);
    const result = await handler({ ...ctx, storage });
    for (const { formId } of stored) await countBypassed(ctx, formId, Date.now());
    return result;
  };
}

function cronWithHandoff(handler: CronHandler): CronHandler {
  return async (event, ctx) => {
    const submissions = ctx.storage["submissions"];
    if (!event.name.startsWith(digestPrefix) || submissions === undefined) {
      await handler(event, ctx);
      try {
        await forgetHandled(ctx, Date.now());
      } catch (error) {
        ctx.log.warn("Old digest marks could not be deleted", {
          error: error instanceof Error ? error.name : "unknown",
        });
      }
      return;
    }
    let handled = new Set<string>();
    try {
      handled = await handledSubmissions(ctx, event.name.slice(digestPrefix.length), Date.now());
    } catch (error) {
      // Without the marks, the digest lists every submission: duplicates, never a loss.
      ctx.log.warn("The digest marks could not be read", {
        error: error instanceof Error ? error.name : "unknown",
      });
    }
    await handler(event, {
      ...ctx,
      storage: { ...ctx.storage, submissions: skipping(submissions, handled) },
    });
  };
}

/**
 * The forms plugin with its `submit` and its cron hook aware of Rondyr, and
 * two admin routes for the submissions posted straight to it. A forms plugin
 * without either keeps it as it is: its emails then go out at once, and the
 * site route reports that they were not held.
 */
export function withRondyrHandoff(plugin: ResolvedPlugin): ResolvedPlugin {
  const submit = plugin.routes["submit"];
  const cron = plugin.hooks.cron;
  if (submit === undefined || cron === undefined) return plugin;
  return {
    ...plugin,
    hooks: { ...plugin.hooks, cron: { ...cron, handler: cronWithHandoff(cron.handler) } },
    routes: {
      ...plugin.routes,
      submit: { ...submit, handler: submitWithHandoff(submit.handler) },
      // Admin only, as the forms plugin's own routes without a permission.
      "rondyr/bypassed": {
        handler: async (ctx: RouteContext) => ({
          items: (await ctx.kv.list(bypassedPrefix)).flatMap(({ key, value }) => {
            const record = BypassedRecord.safeParse(value);
            return record.success
              ? [{ formId: key.slice(bypassedPrefix.length), ...record.data }]
              : [];
          }),
        }),
      },
      "rondyr/bypassed/clear": {
        input: ClearInput,
        handler: async (ctx: RouteContext<z.infer<typeof ClearInput>>) => {
          await ctx.kv.delete(`${bypassedPrefix}${ctx.input.formId}`);
          return { cleared: true };
        },
      },
    },
  };
}
