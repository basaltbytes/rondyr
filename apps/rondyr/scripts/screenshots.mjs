// Takes the screenshots of docs/screenshots again, after a change of the dashboard's
// look. It runs the built Worker in workerd with the simulated services of the tests,
// fills it through the API with the pottery studio of the documentation, and saves
// each screen as a WebP of 2560 by 1600. Nothing leaves the machine: every address is
// on a .example domain and the browser reaches the Worker under one of them.
//
//   pnpm build && node scripts/screenshots.mjs
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { chromium } from "@playwright/test";
import { createInstance } from "i18next";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { unstable_getMiniflareWorkerOptions } from "wrangler";

import {
  testEmailFrom,
  testResendKey,
  testSecretsKey,
  testSetupToken,
} from "../tests/integration/auth-fixture.ts";
import { externalWorkers, workersAiBinding } from "../tests/integration/external-workers.ts";

const app = fileURLToPath(new URL("..", import.meta.url));
const output = fileURLToPath(new URL("../../../docs/screenshots", import.meta.url));
const timeoutMillis = 60_000;

// The texts of the dashboard, with the options of src/dashboard/lib/i18n.ts, so the
// script names an element as the page renders it.
const i18n = createInstance();
await i18n.init({
  lng: "en",
  resources: {
    en: {
      translation: JSON.parse(
        readFileSync(join(app, "src/dashboard/locales/en/translation.json"), "utf8"),
      ),
    },
  },
  initAsync: false,
  interpolation: { escapeValue: false },
});

/** The English text of the dashboard for a key. */
const t = i18n.getFixedT("en");

/** The address that the screenshots show for the Worker. */
const origin = "https://forms.claywork.example";
const site = "https://www.claywork.example";
const webhookUrl = "https://hooks.claywork.example/rondyr";

const owner = {
  name: "Camille",
  email: "camille@claywork.example",
};
const organizationName = "Claywork Studio";
const formName = "Contact";
const businessContext =
  "Pottery studio in Lyon offering wheel-throwing workshops and handmade stoneware ceramics.";
const honeypotField = "_hp";
const confirmedRecipient = "studio@claywork.example";
const pendingRecipient = "bookings@claywork.example";

const accept = { spam: 0.02, solicitation: 0.03, relevance: 0.98 };

/**
 * The messages, oldest first. `scores` is what the simulated model answers for
 * the message, and `honeypot` fills the hidden field, which skips the model.
 */
const messages = [
  {
    name: "Priya",
    email: "priya@family.example",
    message:
      "Sorry, wrong form. I meant to write to the school next door about my son's lunch card.",
    scores: { ...accept, relevance: 0.05 },
  },
  {
    name: "Hannah",
    email: "hannah@mail.example",
    message:
      "Hi! Do you ship mugs to Belgium? I bought one at a market in Lyon last summer and would like four more.",
  },
  {
    name: "Zoe",
    email: "zoe@creators.example",
    message:
      "Hey! I'm a lifestyle creator with 40k followers. Would you offer me a free class in exchange for a reel?",
    scores: { ...accept, spam: 0.4 },
  },
  {
    name: "Tom",
    email: "tom@mail.example",
    message:
      "Here's a photo of the vase that arrived cracked: https://photos.example/a1b2c3 . Can you replace it?",
  },
  {
    name: "Kevin",
    email: "kevin@rankfast.example",
    message: "Get 10,000 backlinks for $49. Rank first on Google in 7 days.",
    honeypot: true,
  },
  {
    name: "Nadia",
    email: "nadia@rhonecrafts.example",
    message:
      "I write for a regional magazine about crafts in the Rhône valley and would like to interview you for the spring issue. Would you have an hour next week?",
  },
  {
    name: "Best Deals",
    email: "offers@deals.example",
    message:
      "Massive discount on smart watches this week only! Order now: https://deals.example/watch",
    scores: { ...accept, spam: 0.95 },
  },
  {
    name: "Ruth",
    email: "ruth@mail.example",
    message:
      "Could I book the Saturday wheel-throwing class for two? We're both beginners. Is an apron provided or should we bring our own?",
  },
  {
    name: "Sam",
    email: "sam@bookings.example",
    message:
      "We help ceramics studios fill weekday classes with local groups. We can send you workshop leads each month and handle the first call. Would you like to see our pricing?",
    scores: { ...accept, solicitation: 0.93 },
  },
  {
    name: "Daniel",
    email: "daniel@thecorner.example",
    message:
      "We're opening a café in March and need 40 stoneware cups with saucers in a matte glaze. Could you send a quote and a lead time?",
  },
  {
    name: "Domain Services",
    email: "billing@domain-renewals.example",
    message:
      "FINAL NOTICE: your domain claywork.example expires today. Renew now at https://domain-renewals.example/claywork or lose your website and your email.",
    scores: { ...accept, spam: 0.97 },
  },
];
const acceptedCount = messages.filter(
  ({ scores, honeypot }) => scores === undefined && honeypot !== true,
).length;

// Jev for the screenshots: the scores of a message are those listed for its sender.
const scoresBySender = Object.fromEntries(
  messages.map(({ email, scores }) => [email, scores ?? accept]),
);
const modelFixture = `
const scoresBySender = ${JSON.stringify(scoresBySender)};
export default {
  async fetch(request) {
    if (new URL(request.url).pathname !== "/ai-gateway/run") return new Response(null, { status: 404 });
    const { inputs } = await request.json();
    const scores = scoresBySender[inputs?.state?.submission_fields?.email];
    if (scores === undefined) return Response.json({});
    const answers = Object.fromEntries(
      Object.keys(inputs.questions)
        .filter((question) => scores[question] !== undefined)
        .map((question) => [question, { type: "noul", noul: scores[question] }]),
    );
    return Response.json({ model: "screenshots-fixture", answers });
  },
};
`;

// The recipient of every webhook: it accepts the message. Resend and Siteverify stay
// the simulated ones of the tests.
const receiverFixture = `
export default {
  fetch(request, env) {
    const { hostname } = new URL(request.url);
    if (hostname === "api.resend.com") return env.RESEND.fetch(request);
    if (hostname === "challenges.cloudflare.com") return env.SITEVERIFY.fetch(request);
    return new Response(null, { status: 204 });
  },
};
`;

const scripts = new Map([
  ["workers-ai-fixture", modelFixture],
  ["webhook-receiver-fixture", receiverFixture],
]);

async function startWorker() {
  const {
    workerOptions: { modulesRules: _rules, ai: _ai, ...workerOptions },
  } = unstable_getMiniflareWorkerOptions(join(app, "dist/rondyr/wrangler.json"));
  const build = join(app, "dist/rondyr");
  const chunks = readdirSync(build, { recursive: true }).filter(
    (file) => file !== "index.js" && file.endsWith(".js"),
  );
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      host: "127.0.0.1",
      port: 0,
      https: true,
      workers: [
        {
          ...workerOptions,
          name: "rondyr-screenshots",
          modules: ["index.js", ...chunks].map((path) => ({
            type: "ESModule",
            path: join(build, path),
          })),
          modulesRoot: build,
          unsafeBindings: [workersAiBinding],
          outboundService: "webhook-receiver-fixture",
          bindings: {
            ...workerOptions.bindings,
            RONDYR_SESSION_SECRET: "screenshots-only-session-secret-42",
            RONDYR_SETUP_TOKEN: testSetupToken,
            RONDYR_SECRETS_KEY: testSecretsKey,
            RESEND_API_KEY: testResendKey,
            RONDYR_EMAIL_FROM: testEmailFrom,
          },
        },
        ...externalWorkers(workerOptions.compatibilityDate).map((worker) => ({
          ...worker,
          script: scripts.get(worker.name) ?? worker.script,
        })),
      ],
    }),
  );
  const { port } = await runtime.ready;
  const database = await runtime.getD1Database("DB", "rondyr-screenshots");
  const migrations = await readD1Migrations({
    migrationsDir: join(app, "database/migrations"),
    migrationsPattern: join(app, "database/migrations/*/migration.sql"),
  });
  for (const { queries } of migrations) {
    await database.batch(queries.map((query) => database.prepare(query)));
  }
  return { runtime, port };
}

/** The emails that the simulated Resend received for an address. */
async function sentEmails(runtime, recipient) {
  const resend = await runtime.getWorker("resend-fixture");
  const response = await resend.fetch(
    `https://api.resend.com/__received?recipient=${encodeURIComponent(recipient)}`,
  );
  return (await response.json()).map((entry) => JSON.parse(entry.body));
}

async function until(what, check) {
  const deadline = Date.now() + timeoutMillis;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== undefined && value !== null && value !== false) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Scrolls the page of the form until an element is at a height of the window. */
async function scrollTo(locator, top) {
  await locator.evaluate((element, height) => {
    const scroller = element.closest("main");
    scroller.scrollBy(0, element.getBoundingClientRect().top - height);
  }, top);
}

const { runtime, port } = await startWorker();
const browser = await chromium.launch({
  // The browser finds the Worker at the address of the documentation.
  args: [`--host-resolver-rules=MAP ${new URL(origin).hostname} 127.0.0.1:${port}`],
});
try {
  const context = await browser.newContext({
    baseURL: origin,
    colorScheme: "light",
    deviceScaleFactor: 2,
    ignoreHTTPSErrors: true,
    locale: "en-GB",
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  const encoder = await context.newPage();
  await encoder.goto(`${origin}/robots.txt`);
  mkdirSync(output, { recursive: true });

  /** Calls the API as the page does, signed in once the owner is. */
  async function api(method, path, json, headers = {}) {
    const answer = await page.evaluate(
      async ([verb, url, body, extra]) => {
        const response = await fetch(url, {
          method: verb,
          headers: { ...(body !== null && { "content-type": "application/json" }), ...extra },
          ...(body !== null && { body: JSON.stringify(body) }),
        });
        const text = await response.text();
        return { status: response.status, text };
      },
      [method, path, json ?? null, headers],
    );
    if (answer.status >= 400) throw new Error(`${method} ${path} answered ${answer.status}`);
    return answer.text === "" ? null : JSON.parse(answer.text);
  }

  /** Saves what the page shows, once its fonts are there and no control is hovered. */
  async function capture(name) {
    await page.mouse.move(640, 0);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    const png = await page.screenshot({ type: "png" });
    // Chromium writes the WebP, so the script needs no image library.
    const webp = await encoder.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.82 });
      const encoded = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (const byte of encoded) binary += String.fromCharCode(byte);
      return btoa(binary);
    }, png.toString("base64"));
    writeFileSync(join(output, `${name}.webp`), Buffer.from(webp, "base64"));
    process.stdout.write(`${name}.webp\n`);
  }

  // A new instance asks for its owner.
  await page.goto("/");
  await page.getByRole("heading", { name: t("setup.title") }).waitFor();
  await capture("setup");

  await page.getByLabel(t("setup.token")).fill(testSetupToken);
  await page.getByRole("textbox", { name: t("setup.name") }).fill(owner.name);
  await page.getByRole("textbox", { name: t("setup.email") }).fill(owner.email);
  await page.getByRole("button", { name: t("setup.submit") }).click();
  await page.getByRole("heading", { name: t("inbox.sections.organization") }).waitFor();
  await api("POST", "/api/organizations", { organizationName, formName, businessContext });
  const [organization] = await api("GET", "/api/organizations");
  const [form] = organization.forms;
  const organizationPath = `/api/organizations/${encodeURIComponent(organization.id)}`;
  const formPath = `${organizationPath}/forms/${encodeURIComponent(form.publicId)}`;
  await api("PATCH", formPath, { emoji: "🏺" });
  await api("PUT", `${formPath}/honeypot`, { field: honeypotField });
  await api("POST", `${formPath}/targets`, { type: "webhook", url: webhookUrl });

  // Each message comes from another visitor, with an address of its own, so the
  // limit of one client on a form does not refuse them.
  for (const [index, { scores: _scores, honeypot, ...fields }] of messages.entries()) {
    const response = await runtime.dispatchFetch(
      `${origin}/f/${encodeURIComponent(form.publicId)}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": `198.51.100.${index + 1}`,
        },
        body: JSON.stringify({
          ...fields,
          ...(honeypot === true && { [honeypotField]: "https://rankfast.example" }),
        }),
      },
    );
    if (response.status !== 202) throw new Error(`A message answered ${response.status}`);
    // The lists sort by time of reception, to the millisecond.
    await page.waitForTimeout(50);
  }
  await until("the classification of the messages", async () => {
    const counts = await api("GET", `${organizationPath}/submission-counts`);
    return (
      counts.accepted === acceptedCount && counts.quarantined === messages.length - acceptedCount
    );
  });

  const dashboard = `/o/${encodeURIComponent(organization.id)}`;
  const open = async (name) => {
    await page
      .getByRole("link", { name: new RegExp(`^${name}\\b`, "u") })
      .first()
      .click();
    await page.getByRole("heading", { name, exact: true }).waitFor();
  };

  await page.goto(`${dashboard}/messages?folder=accepted`);
  await open("Daniel");
  await until("the delivery of the webhook", async () => {
    if (await page.getByText(t("status.deliveries.delivered"), { exact: true }).isVisible()) {
      return true;
    }
    await page.reload();
    return false;
  });
  await capture("inbox");

  await page.goto(`${dashboard}/messages?folder=quarantined`);
  await open("Sam");
  await capture("review");
  // The landing page of the site shows this screen in its dark theme too.
  await page.emulateMedia({ colorScheme: "dark" });
  await capture("review-dark");
  await page.emulateMedia({ colorScheme: "light" });

  await api("POST", `${formPath}/origins`, { origin: site });
  await api("PUT", `${formPath}/success-url`, { url: `${site}/thanks` });
  const formPage = `${dashboard}/forms/${encodeURIComponent(form.publicId)}`;
  const destinations = page.getByLabel(t("inbox.destinations.label", { name: formName }));
  const settingsOf = (index) => destinations.locator("button[aria-expanded]").nth(index);

  await page.goto(formPage);
  await destinations.waitFor();
  await capture("forms");

  await scrollTo(destinations, 400);
  await capture("origins");

  await settingsOf(0).click();
  await page.getByRole("button", { name: t("inbox.destinations.test.send") }).waitFor();
  await scrollTo(destinations, 340);
  await capture("destinations-webhook");

  await api("POST", `${formPath}/targets`, {
    type: "email",
    recipients: [confirmedRecipient, pendingRecipient],
  });
  const token = await until("the confirmation email", async () => {
    const [email] = await sentEmails(runtime, confirmedRecipient);
    return email?.text.match(/\/confirm-recipient#([\w-]{43})/u)?.[1];
  });
  await api("POST", "/api/recipient-confirmations", { token });
  await page.goto(formPage);
  await settingsOf(1).click();
  await page.getByText(t("inbox.emails.statuses.pending")).waitFor();
  await scrollTo(destinations, 290);
  await capture("destinations-email");

  await api("PUT", `${formPath}/turnstile`, {
    siteKey: "0x4AAAAAAAclayworkSiteKey",
    secretKey: "claywork-screenshots-secret",
  });
  await page.goto(formPage);
  const keyState = page.getByText(t("inbox.forms.turnstile.key.working"));
  await keyState.waitFor();
  await scrollTo(keyState, 400);
  await capture("spam-form");

  await api("POST", `${organizationPath}/api-tokens`, { name: "Website" });
  await api("POST", `${organizationPath}/api-tokens`, { name: "Booking app" });
  await page.goto(`${dashboard}/settings/api-tokens`);
  await page.getByText("Booking app").waitFor();
  await capture("api-tokens");

  await page.goto(`${dashboard}/settings/classification`);
  await page.getByRole("button", { name: t("inbox.policy.save") }).waitFor();
  await capture("classification");

  await api("POST", `${organizationPath}/invitations`, {
    email: "leo@claywork.example",
    role: "reviewer",
    language: "en",
  });
  await page.goto(`${dashboard}/settings/members`);
  await page.getByText("leo@claywork.example").waitFor();
  await capture("members");

  await page.goto(`${dashboard}/settings/quotas`);
  await page.getByRole("button", { name: t("common.save"), exact: true }).waitFor();
  await capture("quotas");

  await page.goto(`${dashboard}/settings/retention`);
  await page.getByLabel(t("inbox.retention.quarantine")).fill("90");
  await page.getByRole("button", { name: t("common.save"), exact: true }).click();
  await page.getByText(t("inbox.retention.outcomes.saved")).waitFor();
  await capture("retention");
} finally {
  await browser.close();
  await runtime.dispose();
}
