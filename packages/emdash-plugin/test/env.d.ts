// A script, not a module: the declaration merges into the global Cloudflare.Env.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
  }
}
