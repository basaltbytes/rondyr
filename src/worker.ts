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

// Wrangler and workerd tests use the same classes as Alchemy's generated entry.
const DomainDirectory = durableObject("Submissions.DomainDirectory");
const SubmissionAggregate = durableObject("Submissions.SubmissionAggregate");
const ClassificationPolicy = durableObject("Submissions.ClassificationPolicy");
const DeliveryPolicy = durableObject("Submissions.DeliveryPolicy");
const InboxProjection = durableObject("Submissions.InboxProjection");
const InboxProjectionRun = durableObject("Submissions.InboxProjectionRun");
const ClassifySubmissionWorkflow = durableObject("Submissions.ClassifySubmissionWorkflow");
const DomainBackfill = workflow("Submissions.DomainBackfill");

export {
  DomainDirectory,
  SubmissionAggregate,
  ClassificationPolicy,
  DeliveryPolicy,
  InboxProjection,
  InboxProjectionRun,
  ClassifySubmissionWorkflow,
  DomainBackfill,
};
