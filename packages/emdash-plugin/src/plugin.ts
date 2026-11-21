import { z } from "astro/zod";
import {
  after,
  definePlugin,
  PluginRouteError,
  type ResolvedPlugin,
  type RouteContext,
} from "emdash";

import { FlatFields, FormLayout } from "./core/fields.ts";
import { matchesCredential, enqueueCredential } from "./core/hop.ts";
import { newEntry } from "./core/queue.ts";
import { RondyrError, SubmissionStatus, type Organization } from "./core/rondyr-client.ts";
import { pluginId, pluginVersion } from "./constants.ts";
import { attempt, requeue, sendDue } from "./delivery.ts";
import { rondyrClient, withRondyr } from "./inbox.ts";
import { RondyrOptions, rondyrHost } from "./options.ts";
import { rondyrSecrets } from "./secrets.ts";
import { FormLink, Store, storageConfig } from "./store.ts";
import { receiveWebhook } from "./webhook.ts";

const deliverTask = "deliver";

const EnqueueInput = z.object({
  submissionId: z.uuid(),
  form: FormLayout,
  fields: FlatFields,
});

/** Why the site route could not queue a submission: the slug and an error code, no content. */
const UnqueuedInput = z.object({
  form: z.string().min(1).max(200),
  code: z.string().regex(/^[\w-]{1,64}$/u),
});

const ListInput = z.object({
  status: SubmissionStatus,
  form: z.string().min(1).max(128).nullable().default(null),
  after: z.string().min(1).max(160).nullable().default(null),
});

const MessageInput = z.object({ id: z.uuid() });

const DecisionInput = MessageInput.extend({ decision: z.enum(["approve", "dismiss"]) });

const SaveLinkInput = FormLink.extend({ slug: z.string().min(1).max(200) });

const SlugInput = z.object({ slug: z.string().min(1).max(200) });

/**
 * Reading and decisions are open to every role that reads plugin pages, from
 * Editor up. Settings keep the default permission, `plugins:manage`.
 */
const reader = "plugins:read" as const;

/** Refuse a call to a route of the in-process hop that lacks the credential. */
function requireCredential(ctx: RouteContext<unknown>): void {
  const credential = enqueueCredential(rondyrSecrets().token);
  if (!matchesCredential(ctx.request.headers.get("authorization"), credential)) {
    throw new PluginRouteError("UNAUTHORIZED", "Unknown credential", 401);
  }
}

export function createPlugin(input: RondyrOptions): ResolvedPlugin {
  const options = RondyrOptions.parse(input);
  return definePlugin({
    id: pluginId,
    version: pluginVersion,
    capabilities: ["email:send", "network:request"],
    allowedHosts: [rondyrHost(options)],
    storage: storageConfig,
    hooks: {
      "plugin:activate": {
        handler: async (_event, ctx) => {
          await ctx.cron?.schedule(deliverTask, { schedule: "* * * * *" });
        },
      },
      cron: {
        handler: async (event, ctx) => {
          if (event.name === deliverTask) await sendDue(ctx, options, rondyrSecrets().token);
        },
      },
    },
    routes: {
      // The site's submission route calls this in the same Worker, with the API
      // token (or, without one, a key of this isolate) in `Authorization`. A
      // second call with the same submission ID changes nothing.
      enqueue: {
        public: true,
        methods: ["POST"],
        input: EnqueueInput,
        handler: async (ctx: RouteContext<z.infer<typeof EnqueueInput>>) => {
          requireCredential(ctx);
          const { submissionId, form, fields } = ctx.input;
          const store = new Store(ctx);
          await store.putLayout(form);
          await store.createQueueEntry(submissionId, newEntry(form.slug, fields, Date.now()));
          after(async () => {
            try {
              await attempt(ctx, options, rondyrSecrets().token, submissionId);
            } catch (error) {
              // The entry stays queued; the cron tries again. The error's name only, never its text.
              ctx.log.error("A queued submission could not be sent", {
                submissionId,
                error: error instanceof Error ? error.name : "unknown",
              });
            }
          });
          return { queued: true };
        },
      },
      // The site route calls this when `enqueue` failed twice: the forms plugin
      // kept the submission, and the admin pages show how many were not queued.
      "enqueue/failed": {
        public: true,
        methods: ["POST"],
        input: UnqueuedInput,
        handler: async (ctx: RouteContext<z.infer<typeof UnqueuedInput>>) => {
          requireCredential(ctx);
          ctx.log.error("A submission accepted by the forms plugin could not be queued", {
            form: ctx.input.form,
            code: ctx.input.code,
          });
          await new Store(ctx).recordUnqueued(ctx.input.form, Date.now());
          return { recorded: true };
        },
      },
      webhook: {
        public: true,
        methods: ["POST"],
        request: { body: "bytes", maxBytes: 65_536 },
        handler: async (ctx: RouteContext<Uint8Array>) => {
          const outcome = await receiveWebhook(ctx, rondyrSecrets().webhookSecrets, Date.now());
          if (outcome.status !== 200) {
            throw new PluginRouteError(outcome.code, "Webhook refused", outcome.status);
          }
          return { emailed: outcome.emailed };
        },
      },
      status: {
        permission: reader,
        handler: async (ctx) => {
          const store = new Store(ctx);
          const secrets = rondyrSecrets();
          const [pending, failed, unlinked, unqueued] = await Promise.all([
            store.queueCount("pending"),
            store.queueCount("failed"),
            store.queueCount("unlinked"),
            store.unqueued(),
          ]);
          return {
            tokenProblem: secrets.tokenProblem,
            webhookSecret: secrets.webhookSecrets.length > 0,
            queue: { pending, failed, unlinked },
            unqueued: {
              count: unqueued.reduce((total, { record }) => total + record.count, 0),
              since: unqueued.reduce<number | null>(
                (first, { record }) => Math.min(first ?? record.firstAt, record.firstAt),
                null,
              ),
            },
          };
        },
      },
      "queue/retry": {
        permission: reader,
        handler: async (ctx) => {
          const retried = await requeue(ctx, "failed", null);
          after(async () => {
            await sendDue(ctx, options, rondyrSecrets().token);
          });
          return { retried };
        },
      },
      "messages/overview": {
        permission: reader,
        handler: (ctx) =>
          withRondyr(ctx, options, async (client, organization) => ({
            organization,
            counts: await client.counts(organization.id),
          })),
      },
      "messages/list": {
        permission: reader,
        input: ListInput,
        handler: (ctx: RouteContext<z.infer<typeof ListInput>>) =>
          withRondyr(ctx, options, (client, organization) =>
            client.list(organization.id, ctx.input.status, ctx.input.form, ctx.input.after),
          ),
      },
      "messages/get": {
        permission: reader,
        input: MessageInput,
        handler: (ctx: RouteContext<z.infer<typeof MessageInput>>) =>
          withRondyr(ctx, options, (client, organization) =>
            client.detail(organization.id, ctx.input.id),
          ),
      },
      "messages/decide": {
        permission: reader,
        input: DecisionInput,
        handler: (ctx: RouteContext<z.infer<typeof DecisionInput>>) =>
          withRondyr(ctx, options, (client, organization) =>
            client.decide(organization.id, ctx.input.id, ctx.input.decision),
          ),
      },
      "settings/get": {
        handler: async (ctx) => {
          const store = new Store(ctx);
          const [links, unqueued] = await Promise.all([store.links(), store.unqueued()]);
          const secrets = rondyrSecrets();
          let organization: Organization | null = null;
          let error: string | null = null;
          try {
            organization = await rondyrClient(ctx, options).organization();
          } catch (failure) {
            if (failure instanceof RondyrError) error = failure.failure;
            else if (failure instanceof PluginRouteError) error = failure.code;
            else throw failure;
          }
          return {
            links,
            unqueued,
            tokenProblem: secrets.tokenProblem,
            webhookSecret: secrets.webhookSecrets.length > 0,
            webhookUrl: ctx.url(`/_emdash/api/plugins/${pluginId}/webhook`),
            organization,
            error,
          };
        },
      },
      "settings/save": {
        input: SaveLinkInput,
        handler: async (ctx: RouteContext<z.infer<typeof SaveLinkInput>>) => {
          const { slug, ...link } = ctx.input;
          await new Store(ctx).putLink(slug, link);
          if (link.rondyrFormId === null) return { requeued: 0 };
          const requeued = await requeue(ctx, "unlinked", slug);
          if (requeued > 0) {
            after(async () => {
              await sendDue(ctx, options, rondyrSecrets().token);
            });
          }
          return { requeued };
        },
      },
      // An administrator found the submissions that were not queued (in the
      // forms plugin's export) and clears the warning.
      "settings/unqueued/clear": {
        input: SlugInput,
        handler: async (ctx: RouteContext<z.infer<typeof SlugInput>>) => {
          await new Store(ctx).clearUnqueued(ctx.input.slug);
          return { cleared: true };
        },
      },
    },
    admin: {
      pages: [
        { path: "/", label: "Messages", icon: "inbox" },
        { path: "/settings", label: "Rondyr settings", icon: "gear" },
      ],
      widgets: [{ id: "to-review", title: "Messages to review", size: "third" }],
    },
  });
}
