import type { D1Migration } from "@cloudflare/vitest-plugin";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_WORKER: Fetcher;
      WEBHOOK_RECEIVER: Fetcher;
      RESEND_FIXTURE: Fetcher;
      WORKERS_AI_FIXTURE: Fetcher;
      WORKER_LOGS: Fetcher;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
