import type { D1Migration } from "@cloudflare/vitest-plugin";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_WORKER: Fetcher;
      CLOUDFLARE_EMAIL_WORKER: Fetcher;
      CLOUDFLARE_EMAIL_FIXTURE: Fetcher;
      CLOUDFLARE_EMAIL_DB: D1Database;
      WEBHOOK_RECEIVER: Fetcher;
      RESEND_FIXTURE: Fetcher;
      WORKERS_AI_FIXTURE: Fetcher;
      WORKER_LOGS: Fetcher;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
