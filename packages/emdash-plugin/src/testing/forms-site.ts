import type { FormsPluginOptions } from "@emdash-cms/plugin-forms";
import { z } from "astro/zod";
import {
  PluginRouteError,
  type EmailMessage,
  type PluginContext,
  type ResolvedPlugin,
  type RouteContext,
} from "emdash";
import type { PublicPluginApiRouteHandler } from "emdash/plugin-utils";

import { formsPluginId, pluginId } from "../constants.ts";
import { enqueue, EnqueueInput } from "../enqueue.ts";
import { MemoryCollection, memoryHost } from "./memory-storage.ts";

type KvAccess = PluginContext["kv"];
type Answer = Awaited<ReturnType<PublicPluginApiRouteHandler>>;

export const siteUrl = "https://site.example.com";

/** The forms plugin's KV, in memory, with conditional writes on a revision. */
class MemoryKv implements KvAccess {
  readonly #rows = new MemoryCollection();

  async get<T>(key: string): Promise<T | null> {
    // SAFETY: a test reads back the value it wrote under this key, with the type it wrote.
    return (await this.#rows.get(key)) as T | null;
  }

  async getVersioned<T>(key: string) {
    const row = await this.#rows.getVersioned(key);
    // SAFETY: a test reads back the value it wrote under this key, with the type it wrote.
    return row === null ? null : { value: row.value as T, revision: row.revision };
  }

  compareAndSet: KvAccess["compareAndSet"] = (key, revision, value) =>
    this.#rows.compareAndSet(key, revision, value);

  compareAndDelete: KvAccess["compareAndDelete"] = (key, revision) =>
    this.#rows.compareAndDelete(key, revision);

  set: KvAccess["set"] = (key, value) => this.#rows.put(key, value);

  delete: KvAccess["delete"] = (key) => this.#rows.delete(key);

  list: KvAccess["list"] = async (prefix = "") =>
    [...this.#rows.rows.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, { data }]) => ({ key, value: data }));
}

/** A field of a form, as the forms plugin's editor creates it. */
export interface FieldInput {
  readonly name: string;
  readonly label: string;
  readonly type: "text" | "email" | "textarea";
  readonly required: boolean;
}

/** The settings of a form that the tests set; the forms plugin fills in the rest. */
export interface FormSettingsInput {
  readonly notifyEmails?: readonly string[];
  readonly digestEnabled?: boolean;
  readonly autoresponder?: { readonly subject: string; readonly body: string };
}

const Created = z.object({ id: z.string() });
const Json = z.record(z.string(), z.unknown());
type JsonBody = z.infer<typeof Json>;

/**
 * A site in memory: the forms plugin of `createPlugin`, with its real routes
 * and cron hook over in-memory storage, a mailer that records what it takes,
 * and EmDash's in-process dispatcher for public routes, which the site route
 * calls. `rondyr/enqueue` runs the Rondyr plugin's `enqueue` over its own
 * in-memory storage.
 */
export function formsSite(
  createPlugin: (options: FormsPluginOptions) => ResolvedPlugin,
  clock: () => number = Date.now,
) {
  const plugin = createPlugin({ defaultSpamProtection: "honeypot" });
  const storage = { forms: new MemoryCollection(), submissions: new MemoryCollection() };
  const kv = new MemoryKv();
  const sent: EmailMessage[] = [];
  const scheduled = new Map<string, string>();
  const rondyr = memoryHost();
  const logged: { readonly level: string; readonly message: string }[] = [];
  /** `queueDown` makes the Rondyr plugin's `enqueue` fail; `unqueued` counts the reported failures. */
  const state = { queueDown: false, unqueued: 0 };
  const log = (level: string) => (message: string) => {
    logged.push({ level, message });
  };

  const context = (): PluginContext => ({
    plugin: { id: plugin.id, version: plugin.version },
    storage,
    kv,
    settings: kv,
    log: { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") },
    site: { name: "Site", url: siteUrl, locale: "en" },
    url: (path) => new URL(path, siteUrl).href,
    cron: {
      schedule: async (name, { schedule }) => {
        scheduled.set(name, schedule);
      },
      cancel: async (name) => {
        scheduled.delete(name);
      },
      list: async () => [],
    },
    email: {
      send: async (message) => {
        sent.push(message);
      },
    },
  });

  /** Call a route of the forms plugin as EmDash does: input validated, errors as an envelope. */
  const route = async (name: string, body: JsonBody, request: Request): Promise<Answer> => {
    const definition = plugin.routes[name];
    if (definition === undefined) throw new Error(`Unknown route ${name}`);
    const parsed = definition.input?.safeParse(body) ?? { success: true, data: body };
    if (!parsed.success) {
      return { success: false, error: { code: "VALIDATION_ERROR", message: "" } };
    }
    const ctx: RouteContext = {
      ...context(),
      input: parsed.data,
      request,
      requestMeta: { ip: "203.0.113.7", userAgent: null, referer: null, geo: null },
    };
    try {
      return { success: true, data: await definition.handler(ctx) };
    } catch (error) {
      if (!(error instanceof PluginRouteError)) throw error;
      return { success: false, error: { code: error.code, message: error.message } };
    }
  };

  const handlePublicPluginApiRoute: PublicPluginApiRouteHandler = async (
    target,
    _method,
    path,
    request,
  ) => {
    const body = Json.parse(await request.json());
    if (target === formsPluginId) return route(path.slice(1), body, request);
    if (target === pluginId && path === "/enqueue") {
      if (state.queueDown) throw new Error("D1_ERROR: storage unavailable");
      const queued = await enqueue(rondyr.host, EnqueueInput.parse(body), clock());
      return { success: true, data: { queued: true, ...queued } };
    }
    if (target === pluginId && path === "/enqueue/failed") {
      state.unqueued += 1;
      return { success: true, data: { recorded: true } };
    }
    throw new Error(`Unexpected route ${target}${path}`);
  };

  /** Create a form through the forms plugin's own admin route, as its editor does. */
  const createForm = async (
    slug: string,
    fields: readonly FieldInput[],
    settings: FormSettingsInput = {},
  ) => {
    const answer = await route(
      "forms/create",
      {
        name: `Form ${slug}`,
        slug,
        pages: [{ fields: fields.map((field, index) => ({ id: `f${index}`, ...field })) }],
        settings: { spamProtection: "honeypot", ...settings },
      },
      new Request(`${siteUrl}/_emdash/api/plugins/${formsPluginId}/forms/create`),
    );
    if (!answer.success) throw new Error(`The form could not be created: ${answer.error?.code}`);
    return Created.parse(answer.data).id;
  };

  /** Post straight to the forms plugin's own public route, as its Form block does. */
  const postToFormsPlugin = (formId: string, data: Readonly<Record<string, string>>) =>
    route(
      "submit",
      { formId, data },
      new Request(`${siteUrl}/_emdash/api/plugins/${formsPluginId}/submit`, {
        method: "POST",
        headers: { "x-rondyr-handoff": "a-guessed-value" },
      }),
    );

  /** Run the forms plugin's cron hook for a task, as EmDash's scheduler does. */
  const runCron = async (name: string) => {
    const cron = plugin.hooks.cron;
    if (cron === undefined) throw new Error("The forms plugin has no cron hook");
    await cron.handler({ name, scheduledAt: new Date(clock()).toISOString() }, context());
  };

  return {
    plugin,
    storage,
    kv,
    sent,
    scheduled,
    rondyr,
    logged,
    state,
    locals: { emdash: { handlePublicPluginApiRoute } },
    route,
    createForm,
    postToFormsPlugin,
    runCron,
  };
}
