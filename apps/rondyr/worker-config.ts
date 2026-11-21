// The Worker's deployment definition is the root wrangler.json: the Deploy to Cloudflare
// button reads it at the root of the repository. Every tool of this package reads it
// through this module: Vite, Vitest, the browser tests, the doctor and the Alchemy stack.
import { fileURLToPath } from "node:url";

import wrangler from "../../wrangler.json" with { type: "json" };

export { wrangler };

/** The absolute path of the root wrangler.json. */
export const wranglerConfigPath = fileURLToPath(new URL("../../wrangler.json", import.meta.url));

interface QueueConfig {
  readonly producers?: ReadonlyArray<{ readonly binding: string; readonly queue?: string }>;
  readonly consumers?: ReadonlyArray<{
    readonly queue: string;
    readonly dead_letter_queue?: string;
  }>;
}

/** The producer bindings whose queues the Worker consumes, by the variables they name. */
const consumedQueues = ["CLASSIFICATION_QUEUE", "DELIVERY_QUEUE"] as const;
type ConsumedQueue = (typeof consumedQueues)[number];

/** The name of each consumed queue and of its dead-letter queue, as the Worker reads them. */
export interface QueueNameVars {
  CLASSIFICATION_QUEUE_NAME?: string;
  CLASSIFICATION_DEAD_LETTER_QUEUE_NAME?: string;
  DELIVERY_QUEUE_NAME?: string;
  DELIVERY_DEAD_LETTER_QUEUE_NAME?: string;
}

const deadLetterVariable = {
  CLASSIFICATION_QUEUE: "CLASSIFICATION_DEAD_LETTER_QUEUE_NAME",
  DELIVERY_QUEUE: "DELIVERY_DEAD_LETTER_QUEUE_NAME",
} as const satisfies Record<ConsumedQueue, keyof QueueNameVars>;

/**
 * The variables that tell the queue handler which queue a batch comes from: the name of
 * each consumed queue and of its dead-letter queue, read from the queue configuration.
 * The configuration is the only place that names a queue, so a queue renamed there, for
 * example on the Deploy to Cloudflare form, keeps its batches on the right consumer.
 */
export function queueNameVars(queues: QueueConfig | undefined): QueueNameVars {
  const vars: QueueNameVars = {};
  for (const binding of consumedQueues) {
    const producer = queues?.producers?.find((candidate) => candidate.binding === binding);
    if (producer?.queue === undefined) continue;
    vars[`${binding}_NAME` as const] = producer.queue;
    const deadLetter = queues?.consumers?.find(
      (candidate) => candidate.queue === producer.queue,
    )?.dead_letter_queue;
    if (deadLetter !== undefined) {
      vars[deadLetterVariable[binding]] = deadLetter;
    }
  }
  return vars;
}
