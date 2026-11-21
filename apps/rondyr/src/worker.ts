import {
  makeDurableObjectBridge,
  makeWorkerBridge,
  makeWorkflowBridge,
} from "@alchemy.run/cloudflare/Bridge";
import { Worker } from "@alchemy.run/cloudflare/Workers/Worker";
import { DurableObject, WorkerEntrypoint, WorkflowEntrypoint } from "cloudflare:workers";

import { workerImplementation } from "./worker-implementation.ts";

const localWorker = Worker("App", { main: import.meta.url }, workerImplementation);
const entry = { entrypoint: localWorker, stack: { name: "Rondyr", stage: "local" } };
export default makeWorkerBridge(WorkerEntrypoint, entry);

// @effect-diagnostics missingEffectContext:off
// @ts-expect-error The bridge supplies the Worker's construction services through its runtime layer.
const durableObject = makeDurableObjectBridge(DurableObject, entry);
// @ts-expect-error The bridge supplies construction services and forwards the native constructor arguments.
const workflow = makeWorkflowBridge(WorkflowEntrypoint, entry);

/**
 * The Vite dev server runs each Durable Object behind a wrapper that serves an RPC call
 * only when the class's prototype has the method. The bridge resolves its methods when
 * they are called (`send`, the backfill's calls), so under `pnpm dev` the aggregate's
 * `send` failed and every message stayed `received`. In the dev server, each class is a
 * Durable Object whose prototype has every method, including `fetch` and `alarm`, each
 * one forwarded to a bridge instance. A build exports the bridge itself, which workerd
 * calls through the instance.
 */
function servedByDevServer(bridge: ReturnType<typeof durableObject>) {
  if (!import.meta.env.DEV) return bridge;
  const bridges = new WeakMap<DurableObject, ReturnType<typeof durableObject>>();
  class Served extends DurableObject {
    constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
      super(ctx, env);
      bridges.set(this, new bridge(ctx, env));
    }
  }
  const inherited = Object.create(DurableObject.prototype);
  // Below the class, the prototype has every method name, and stays a DurableObject's.
  const methods = new Proxy(inherited, {
    has: () => true,
    get: (target, key, instance: DurableObject) => {
      // A thenable would be awaited instead of called.
      if (key in target || key === "then") return target[key];
      return (...args: ReadonlyArray<never>) => bridges.get(instance)[key](...args);
    },
  });
  Object.setPrototypeOf(Served.prototype, methods);
  return Served;
}

const object = (name: string) => servedByDevServer(durableObject(name));

// Wrangler and workerd tests use the same classes as Alchemy's generated entry.
const DomainDirectory = object("Submissions.DomainDirectory");
const SubmissionAggregate = object("Submissions.SubmissionAggregate");
const ClassificationPolicy = object("Submissions.ClassificationPolicy");
const DeliveryPolicy = object("Submissions.DeliveryPolicy");
const InboxProjection = object("Submissions.InboxProjection");
const InboxProjectionRun = object("Submissions.InboxProjectionRun");
const ClassifySubmissionWorkflow = object("Submissions.ClassifySubmissionWorkflow");
const CronHeartbeatObject = object("CronHeartbeatObject");
const DomainBackfill = workflow("Submissions.DomainBackfill");

export {
  DomainDirectory,
  SubmissionAggregate,
  ClassificationPolicy,
  DeliveryPolicy,
  InboxProjection,
  InboxProjectionRun,
  ClassifySubmissionWorkflow,
  CronHeartbeatObject,
  DomainBackfill,
};
