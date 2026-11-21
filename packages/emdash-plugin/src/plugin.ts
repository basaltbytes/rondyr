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

const ListInput = z.object({
  status: SubmissionStatus,
  form: z.string().min(1).max(128).nullable().default(null),
  after: z.string().min(1).max(160).nullable().default(null),
});

const MessageInput = z.object({ id: z.uuid() });

const DecisionInput = MessageInput.extend({ decision: z.enum(["approve", "dismiss"]) });

const SaveLinkInput = FormLink.extend({ slug: z.string().min(1).max(200) });

/**
 * Reading and decisions are open to every role that reads plugin pages, from
 * Editor up. Settings keep the default permission, `plugins:manage`.
 */
const reader = "plugins:read" as const;

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
      // token (or, without one, a key of this isolate) in `Authorization`.
      enqueue: {
        public: true,
        methods: ["POST"],
        input: EnqueueInput,
        handler: async (ctx: RouteContext<z.infer<typeof EnqueueInput>>) => {
          const credential = enqueueCredential(rondyrSecrets().token);
          if (!matchesCredential(ctx.request.headers.get("authorization"), credential)) {
            throw new PluginRouteError("UNAUTHORIZED", "Unknown credential", 401);
          }
          const { submissionId, form, fields } = ctx.input;
          const store = new Store(ctx);
          await store.putLayout(form);
          if ((await store.queueEntry(submissionId)) !== null) return { queued: true };
          const entry = newEntry(form.slug, fields, Date.now());
          await store.putQueueEntry(submissionId, entry);
          after(() => attempt(ctx, options, rondyrSecrets().token, submissionId, entry));
          return { queued: true };
        },
      },
      webhook: {
        public: true,
        methods: ["POST"],
        request: { body: "bytes", maxBytes: 65_536 },
        handler: async (ctx: RouteContext<Uint8Array>) => {
          const outcome = await receiveWebhook(ctx, rondyrSecrets().webhookSecret, Date.now());
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
          const [pending, failed, unlinked] = await Promise.all([
            store.queueCount("pending"),
            store.queueCount("failed"),
            store.queueCount("unlinked"),
          ]);
          return {
            token: secrets.token !== null,
            webhookSecret: secrets.webhookSecret !== null,
            queue: { pending, failed, unlinked },
          };
        },
      },
      "queue/retry": {
        permission: reader,
        handler: async (ctx) => {
          const retried = await requeue(ctx, "failed", null);
          after(() => sendDue(ctx, options, rondyrSecrets().token));
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
          const links = await store.links();
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
            token: secrets.token !== null,
            webhookSecret: secrets.webhookSecret !== null,
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
          if (requeued > 0) after(() => sendDue(ctx, options, rondyrSecrets().token));
          return { requeued };
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
