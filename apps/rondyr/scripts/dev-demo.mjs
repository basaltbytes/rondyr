// Starts `pnpm dev` on a database of its own that already has something to look at:
// an owner account, an organization, two active forms and a suspended one, and
// messages to review, accepted and archived. The database and its secrets stay in
// .wrangler/demo, so the next run finds the same data and adds nothing.
//
//   node scripts/dev-demo.mjs [--port 5173]
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";

const app = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const wrangler = join(dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js");
const classificationTimeoutMillis = 90_000;

/** The account of the demo. It exists only in the local database of .wrangler/demo. */
const owner = {
  name: "Demo owner",
  email: "owner@example.test",
  password: "rondyr local demo",
};

const organizationName = "Atelier Terre";
const businessContext = "A pottery studio that sells classes, workshops and made-to-order pieces.";

/**
 * The forms of the demo, and the messages that each one receives. The local
 * dev server has no model, so every message ends in quarantine; `decision` is
 * what the owner then decides, and a message without one stays to review.
 */
const forms = [
  {
    name: "Contact",
    messages: [
      {
        name: "Inès Morel",
        email: "ines.morel@example.test",
        message: "Is there room left in the Thursday evening wheel class?",
        decision: "approve",
      },
      {
        name: "Tomasz Zieliński",
        email: "tomasz@example.test",
        message: "Do you ship the large planters to Poland, and what would it cost?",
      },
      {
        name: "Camille Roy",
        email: "camille.roy@example.test",
        message: "I would like to offer a class as a gift. Do you sell vouchers?",
      },
      {
        name: "SEO Growth Team",
        email: "sales@example.test",
        message: "We can put your website on the first page of search results in 30 days.",
        decision: "dismiss",
      },
      {
        name: "Louis Perrin",
        email: "louis.perrin@example.test",
        message: "My bowl arrived chipped. Can it be replaced?",
      },
    ],
  },
  {
    name: "Quote request",
    emoji: "🧾",
    messages: [
      {
        name: "Hôtel des Quais",
        email: "achats@example.test",
        message: "We need 120 espresso cups with our logo before March.",
        quantity: "120",
        decision: "approve",
      },
      {
        name: "Nadia Benali",
        email: "nadia.benali@example.test",
        message: "A dinner set for eight in the speckled glaze, please.",
        quantity: "8",
      },
      {
        name: "Studio Fabre",
        email: "contact@example.test",
        message: "Twelve hanging planters for a shop window, in two sizes.",
        quantity: "12",
      },
    ],
  },
  { name: "Newsletter", emoji: "📮", suspended: true, messages: [] },
];

function fail(message) {
  throw new Error(`pnpm dev:demo: ${message}`);
}

/** The secrets of the demo, generated on its first run. */
function secrets(file) {
  if (!existsSync(file)) {
    const lines = [
      `BETTER_AUTH_SECRET=${randomBytes(32).toString("hex")}`,
      `RONDYR_SETUP_TOKEN=${randomBytes(32).toString("hex")}`,
    ];
    writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
  }
  return parseEnv(readFileSync(file, "utf8"));
}

async function seed(origin, setupToken) {
  const json = (body, headers = {}) => ({
    method: "POST",
    headers: { "content-type": "application/json", origin, ...headers },
    body: JSON.stringify(body),
  });

  const setup = await fetch(
    `${origin}/api/setup`,
    json(owner, { authorization: `Bearer ${setupToken}` }),
  );
  // 404: the owner exists, so an earlier run has made the demo.
  if (setup.status === 404) return false;
  if (setup.status !== 201) fail(`POST /api/setup answered ${setup.status}`);

  const signIn = await fetch(`${origin}/api/auth/sign-in/email`, json(owner));
  if (signIn.status !== 200) fail(`sign-in answered ${signIn.status}`);
  const cookie = signIn.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  const session = { cookie, origin };

  const [first, ...others] = forms;
  const created = await fetch(
    `${origin}/api/organizations`,
    json({ organizationName, formName: first.name, businessContext }, session),
  );
  if (created.status !== 201) fail(`creating the organization answered ${created.status}`);
  const [organization] = await (
    await fetch(`${origin}/api/organizations`, { headers: session })
  ).json();
  const organizationUrl = `${origin}/api/organizations/${encodeURIComponent(organization.id)}`;
  const publicIds = new Map([[first.name, organization.forms[0].publicId]]);

  for (const { name, emoji } of others) {
    const response = await fetch(`${organizationUrl}/forms`, json({ name, emoji }, session));
    if (!response.ok) fail(`creating the form ${name} answered ${response.status}`);
    publicIds.set(name, (await response.json()).publicId);
  }

  const decisions = new Map();
  let expected = 0;
  for (const { name, messages } of forms) {
    for (const { decision, ...fields } of messages) {
      const response = await fetch(`${origin}/f/${publicIds.get(name)}`, json(fields));
      if (response.status !== 202) fail(`a message to ${name} answered ${response.status}`);
      if (decision !== undefined) decisions.set(fields.email, decision);
      expected += 1;
    }
  }

  // A decision needs a classified message. The queue consumer takes a few seconds.
  const deadline = Date.now() + classificationTimeoutMillis;
  let entries = [];
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const page = await (await fetch(`${organizationUrl}/submissions`, { headers: session })).json();
    entries = page.entries;
    const classified = entries.filter(({ status }) => status === "quarantined");
    if (classified.length === expected) break;
  }
  if (entries.length !== expected || entries.some(({ status }) => status !== "quarantined")) {
    fail(`the messages are not all classified after ${classificationTimeoutMillis / 1000} seconds`);
  }
  for (const entry of entries) {
    const decision = decisions.get(entry.preview.email);
    if (decision === undefined) continue;
    const response = await fetch(
      `${organizationUrl}/submissions/${encodeURIComponent(entry.submissionId)}/${decision}`,
      json({}, session),
    );
    if (!response.ok) fail(`the decision ${decision} answered ${response.status}`);
  }

  for (const { name, suspended } of forms) {
    if (suspended !== true) continue;
    const response = await fetch(
      `${organizationUrl}/forms/${encodeURIComponent(publicIds.get(name))}/suspend`,
      json({}, session),
    );
    if (!response.ok) fail(`suspending the form ${name} answered ${response.status}`);
  }
  return true;
}

const { values } = parseArgs({ options: { port: { type: "string" } } });
const directory = join(app, ".wrangler", "demo");
const state = join(directory, "state");
const envFile = join(directory, ".env");
mkdirSync(directory, { recursive: true });
const { RONDYR_SETUP_TOKEN: setupToken } = secrets(envFile);
if (setupToken === undefined) fail(`${envFile} has no RONDYR_SETUP_TOKEN; delete ${directory}`);
process.env.RONDYR_DEV_STATE = state;
process.env.RONDYR_DEV_ENV_FILE = envFile;

execFileSync(
  process.execPath,
  [wrangler, "d1", "migrations", "apply", "DB", "--local", "-c", "../../wrangler.json"].concat([
    "--persist-to",
    state,
  ]),
  { cwd: app, stdio: ["ignore", "ignore", "inherit"] },
);
const { createServer } = await import("vite");
const server = await createServer({
  configFile: join(app, "vite.config.ts"),
  root: app,
  server: values.port === undefined ? {} : { port: Number(values.port), strictPort: true },
});
try {
  await server.listen();
  const origin = new URL(server.resolvedUrls.local[0]).origin;
  const seeded = await seed(origin, setupToken);
  process.stdout.write(
    [
      "",
      seeded
        ? `Demo data created: ${organizationName}, ${forms.length} forms.`
        : "Demo data found.",
      `Sign in as ${owner.email} with the password "${owner.password}".`,
      `Delete ${directory} to start again from an empty database.`,
      "",
    ].join("\n"),
  );
  server.printUrls();
} catch (error) {
  await server.close();
  throw error;
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void server.close().finally(() => process.exit(0));
  });
}
