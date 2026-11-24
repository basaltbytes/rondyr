// The build derives these variables from the queues of the root wrangler.json
// (worker-config.ts), and the Alchemy stack passes the names it generates, so
// `wrangler types` does not see them in the configuration.
declare namespace Cloudflare {
  interface Env {
    CLASSIFICATION_QUEUE_NAME: string;
    CLASSIFICATION_DEAD_LETTER_QUEUE_NAME: string;
    DELIVERY_QUEUE_NAME: string;
    DELIVERY_DEAD_LETTER_QUEUE_NAME: string;
  }
}
