// Uploads the built site in dist/ to the `rondyr-docs` Worker, at the address that
// RONDYR_DOCS_URL gives: a custom domain, or the Worker's own workers.dev address.
//
//   RONDYR_DOCS_URL=https://docs.example.com pnpm --filter @rondyr/docs build
//   RONDYR_DOCS_URL=https://docs.example.com pnpm --filter @rondyr/docs run deploy
//
// Wrangler reads CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID from the environment, or
// uses the account of `wrangler login`.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The Worker name in wrangler.jsonc, which is also the first label of its workers.dev address. */
export const workerName = "rondyr-docs";

/** The arguments of `wrangler deploy` for the site's address, or an error message. */
export function deployArguments(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === "") {
    throw new Error("Set RONDYR_DOCS_URL to the HTTPS address of the documentation site.");
  }
  const url = new URL(value.trim());
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error(`RONDYR_DOCS_URL must be an HTTPS origin with no path: ${value}`);
  }
  if (url.hostname.endsWith(".workers.dev")) {
    if (!url.hostname.startsWith(`${workerName}.`)) {
      throw new Error(`A workers.dev address of this Worker starts with ${workerName}.: ${value}`);
    }
    return ["deploy", "--config", "wrangler.jsonc"];
  }
  return ["deploy", "--config", "wrangler.jsonc", "--domain", url.hostname];
}

/** Whether the build in `directory` was made for `origin`, according to its sitemap. */
export function builtFor(directory: URL, origin: string): boolean {
  const sitemap = new URL("sitemap-0.xml", directory);
  return existsSync(sitemap) && readFileSync(sitemap, "utf8").includes(`<loc>${origin}/</loc>`);
}

function main(): void {
  const value = process.env["RONDYR_DOCS_URL"];
  const args = deployArguments(value);
  const origin = new URL(value ?? "").origin;
  const dist = new URL("../dist/", import.meta.url);
  if (!builtFor(dist, origin)) {
    throw new Error(
      `dist/ is missing or was built for another address. Build it with RONDYR_DOCS_URL=${origin} first.`,
    );
  }
  execFileSync("wrangler", args, {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    stdio: "inherit",
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
