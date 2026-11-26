// Checks the local loop of `pnpm dev`: the Vite dev server, not the build that the other
// tests run. On a database of its own, it creates the owner account, an organization
// and a form, posts a submission, and waits until the queue consumer has classified it,
// accepted or quarantined. A Durable Object that the dev server cannot call leaves the
// submission `received`, which fails the check.
//
//   node scripts/dev-server-check.mjs
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { registerVirtualPasskey } from "../tests/integration/webauthn-helper.mjs";

const app = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const wrangler = join(dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js");
const timeoutMillis = 90_000;

const directory = mkdtempSync(join(tmpdir(), "rondyr-dev-check-"));
const state = join(directory, "state");
const token = randomBytes(32).toString("hex");
const envFile = join(directory, ".env");
writeFileSync(
  envFile,
  `RONDYR_SESSION_SECRET=${randomBytes(32).toString("hex")}\nRONDYR_SETUP_TOKEN=${token}\n`,
  { mode: 0o600 },
);
process.env.RONDYR_DEV_STATE = state;
process.env.RONDYR_DEV_ENV_FILE = envFile;

function fail(message) {
  throw new Error(`pnpm dev check: ${message}`);
}

let server;
try {
  execFileSync(
    process.execPath,
    [wrangler, "d1", "migrations", "apply", "DB", "--local", "-c", "../../wrangler.json"].concat([
      "--persist-to",
      state,
    ]),
    { cwd: app, stdio: ["ignore", "ignore", "inherit"] },
  );
  const { createServer } = await import("vite");
  server = await createServer({
    configFile: join(app, "vite.config.ts"),
    root: app,
    logLevel: "warn",
    // Sign-in accepts plain HTTP on `localhost` only, the one loopback name a passkey works on.
    server: { port: 0, host: "localhost" },
  });
  await server.listen();
  const origin = new URL(server.resolvedUrls.local[0]).origin;
  const json = (body, headers = {}) => ({
    method: "POST",
    headers: { "content-type": "application/json", origin, ...headers },
    body: JSON.stringify(body),
  });

  const owner = {
    name: "Dev check",
    email: "dev-check@example.test",
  };
  const optionsResponse = await fetch(
    `${origin}/api/setup/options`,
    json(owner, { authorization: `Bearer ${token}` }),
  );
  if (optionsResponse.status !== 200) {
    fail(`POST /api/setup/options answered ${optionsResponse.status}`);
  }
  const creationOptions = await optionsResponse.json();
  const { credential } = await registerVirtualPasskey(creationOptions, origin);
  const setup = await fetch(
    `${origin}/api/setup/verify`,
    json({ credential }, { authorization: `Bearer ${token}` }),
  );
  if (setup.status !== 201) fail(`POST /api/setup/verify answered ${setup.status}`);
  const cookie = setup.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  const session = { cookie, origin };
  const created = await fetch(
    `${origin}/api/organizations`,
    json({ organizationName: "Dev check", formName: "Contact", businessContext: "" }, session),
  );
  if (created.status !== 201) fail(`creating the organization answered ${created.status}`);
  const [organization] = await (
    await fetch(`${origin}/api/organizations`, { headers: session })
  ).json();
  const [form] = organization.forms;
  const submitted = await fetch(
    `${origin}/f/${form.publicId}`,
    json({ message: "Is there room in the pottery class?", "fixture-verdict": "accept" }),
  );
  if (submitted.status !== 202) fail(`the submission answered ${submitted.status}`);

  const inbox = `${origin}/api/organizations/${encodeURIComponent(organization.id)}/submissions`;
  const deadline = Date.now() + timeoutMillis;
  let status = "received";
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const page = await (await fetch(inbox, { headers: session })).json();
    const entry = page.entries[0];
    status = entry?.status ?? "received";
    if (status === "accepted" || status === "quarantined") {
      const reason =
        entry.reason === null || entry.reason === undefined ? "" : ` (${entry.reason})`;
      process.stdout.write(`The dev server classified a submission: ${status}${reason}.\n`);
      break;
    }
  }
  if (status !== "accepted" && status !== "quarantined") {
    fail(`the submission is still ${status} after ${timeoutMillis / 1000} seconds`);
  }
} finally {
  await server?.close();
  rmSync(directory, { recursive: true, force: true });
}
