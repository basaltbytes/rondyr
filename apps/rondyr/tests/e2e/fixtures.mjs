import { readFile, readdir } from "node:fs/promises";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { expect, test as base } from "@playwright/test";
import { createInstance } from "i18next";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { unstable_getMiniflareWorkerOptions } from "wrangler";

import {
  testEmailFrom,
  testRecoveryToken,
  testResendKey,
  testSecretsKey,
  testSetupToken,
} from "../integration/auth-fixture.ts";
import { externalWorkers, workersAiBinding } from "../integration/external-workers.ts";
import { registerVirtualPasskey } from "../integration/webauthn-helper.mjs";
import en from "../../src/dashboard/locales/en/translation.json" with { type: "json" };
import fr from "../../src/dashboard/locales/fr/translation.json" with { type: "json" };

// The texts of the dashboard, from the files that the dashboard ships and with
// the options of src/dashboard/lib/i18n.ts, so a test names an element and
// states an expected text as the page renders them.
const i18n = createInstance();
await i18n.init({
  lng: "en",
  fallbackLng: "en",
  resources: { en: { translation: en }, fr: { translation: fr } },
  initAsync: false,
  interpolation: { escapeValue: false },
});

/** The English text of the dashboard for a key. The tests run in an English browser. */
export const t = i18n.getFixedT("en");

/** The French text of the dashboard for a key. */
export const frenchT = i18n.getFixedT("fr");

/** The account that the `dashboard` fixture signs in with. */
export const owner = {
  name: "Forms manager",
  email: "owner@example.test",
};

/** Attach a Chromium CDP virtual CTAP2 authenticator to `page` for real WebAuthn passkeys. */
export async function attachVirtualAuthenticator(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}

/** Replace the virtual authenticator on `page` to simulate registering a passkey on another device. */
export async function replaceVirtualAuthenticator(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.disable");
  return attachVirtualAuthenticator(page);
}

/** The texts and the names of the external website that hosts a contact form. */
export const externalSite = {
  contactHeading: "Contact us",
  messageField: "Your message",
  submitButton: "Send message",
  thanksPath: "/thanks",
  thanksHeading: "Thank you for your message",
  /** The hidden field of the contact form. */
  honeypotField: "company",
  /** The query parameter of the contact page that fills the hidden field. */
  honeypotParameter: "honeypot",
};

const externalSiteWorker = `
export default {
  fetch(request, env) {
    const url = new URL(request.url);
    const formId = url.searchParams.get("form");
    if (url.pathname === "${externalSite.thanksPath}") {
      return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><h1>${externalSite.thanksHeading}</h1></html>', {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (url.pathname !== "/contact" || !formId) return new Response(null, { status: 404 });
    const action = env.DASHBOARD_ORIGIN + "/f/" + encodeURIComponent(formId);
    const company = url.searchParams.has("${externalSite.honeypotParameter}") ? "robot" : "";
    return new Response(\`<!doctype html><html lang="en"><meta charset="utf-8"><h1>${externalSite.contactHeading}</h1>
      <form method="post" action="\${action}">
        <label>${externalSite.messageField} <textarea name="message" required></textarea></label>
        <input type="hidden" name="fixture-verdict" value="accept">
        <input name="${externalSite.honeypotField}" value="\${company}" hidden tabindex="-1" autocomplete="off">
        <button>${externalSite.submitButton}</button>
      </form></html>\`, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
};
`;

export const test = base.extend({
  /** The stage's `RONDYR_ESCALATION_CLASSIFIER`. A stage has no second classifier by default. */
  escalationClassifier: [null, { option: true }],

  /** Whether the owner account exists. A new instance shows its setup page instead. */
  claimed: [true, { option: true }],

  dashboardRuntime: async ({ request, escalationClassifier, claimed }, use) => {
    const {
      // Workers AI is the fixture of tests/integration/external-workers.ts.
      workerOptions: { modulesRules: _rules, ai: _ai, ...workerOptions },
    } = unstable_getMiniflareWorkerOptions("./dist/rondyr/wrangler.json");
    const files = await readdir("./dist/rondyr", { recursive: true });
    const chunks = files.filter((file) => file !== "index.js" && file.endsWith(".js"));
    const runtime = new Miniflare(
      convertV4MiniflareOptions({
        host: "localhost",
        port: 0,
        workers: [
          {
            ...workerOptions,
            name: "rondyr-browser-test",
            modules: ["index.js", ...chunks].map((path) => ({ type: "ESModule", path })),
            unsafeBindings: [workersAiBinding],
            outboundService: "webhook-receiver-fixture",
            bindings: {
              ...workerOptions.bindings,
              RONDYR_SESSION_SECRET: "playwright-local-session-secret-42",
              RONDYR_SETUP_TOKEN: testSetupToken,
              RONDYR_RECOVERY_TOKEN: testRecoveryToken,
              RONDYR_SECRETS_KEY: testSecretsKey,
              RESEND_API_KEY: testResendKey,
              RONDYR_EMAIL_FROM: testEmailFrom,
              ...(escalationClassifier !== null && {
                RONDYR_ESCALATION_CLASSIFIER: escalationClassifier,
              }),
            },
          },
          ...externalWorkers(workerOptions.compatibilityDate),
        ],
      }),
    );
    try {
      const { origin } = await runtime.ready;
      const db = await runtime.getD1Database("DB", "rondyr-browser-test");
      const migrations = await readD1Migrations({
        migrationsDir: "database/migrations",
        migrationsPattern: "database/migrations/*/migration.sql",
      });
      for (const { queries } of migrations) {
        await db.batch(queries.map((query) => db.prepare(query)));
      }
      if (claimed) {
        const headers = { authorization: `Bearer ${testSetupToken}`, origin };
        const optionsResponse = await request.post(`${origin}/api/setup/options`, {
          headers,
          data: owner,
        });
        expect(optionsResponse.status(), "POST /api/setup/options").toBe(200);
        const creationOptions = await optionsResponse.json();
        const { credential } = await registerVirtualPasskey(creationOptions, origin);
        const setup = await request.post(`${origin}/api/setup/verify`, {
          headers,
          data: { credential, passkeyName: "Seed key" },
        });
        expect(setup.status(), "POST /api/setup/verify").toBe(201);
      }
      await use({ origin, runtime, database: db });
    } finally {
      await runtime.dispose();
    }
  },

  dashboardOrigin: async ({ dashboardRuntime }, use) => {
    await use(dashboardRuntime.origin);
  },

  /** The emails that the fake Resend received for an address, oldest first. */
  sentEmails: async ({ dashboardRuntime }, use) => {
    await use(async (recipient) => {
      const resend = await dashboardRuntime.runtime.getWorker("resend-fixture");
      const response = await resend.fetch(
        `https://api.resend.com/__received?recipient=${encodeURIComponent(recipient)}`,
      );
      const received = await response.json();
      return received.map((entry) => JSON.parse(entry.body));
    });
  },

  /** The D1 database of the dashboard's Worker, for a state that only hours of processing reach. */
  database: async ({ dashboardRuntime }, use) => {
    await use(dashboardRuntime.database);
  },

  externalOrigin: async ({ dashboardOrigin }, use) => {
    const runtime = new Miniflare(
      convertV4MiniflareOptions({
        host: "127.0.0.1",
        port: 0,
        https: true,
        modules: true,
        script: externalSiteWorker,
        bindings: { DASHBOARD_ORIGIN: dashboardOrigin },
      }),
    );
    try {
      const { origin } = await runtime.ready;
      await use(origin);
    } finally {
      await runtime.dispose();
    }
  },

  dashboard: async ({ context, dashboardOrigin, page }, use) => {
    const violations = [];
    context.on("console", (message) => {
      if (/content.security.policy/iu.test(message.text())) violations.push(message.text());
    });
    await attachVirtualAuthenticator(page);
    const headers = await readFile("public/_headers", "utf8");
    const policy = headers.match(/^\s*Content-Security-Policy: (.+)$/mu)?.[1];
    expect(policy, "CSP in public/_headers").toBeTruthy();
    const response = await page.goto(dashboardOrigin);
    expect(await response?.headerValue("content-security-policy")).toBe(policy);
    // Register a real browser passkey for the owner via recovery and sign in immediately.
    await page.getByRole("button", { name: t("authentication.recovery.toggle") }).click();
    await page.getByLabel(t("authentication.recovery.token")).fill(testRecoveryToken);
    await page.getByRole("textbox", { name: t("authentication.signIn.email") }).fill(owner.email);
    await page
      .getByRole("button", { name: t("authentication.recovery.submit"), exact: true })
      .click();
    // The account has no organization yet, so the dashboard opens on its first run.
    await expect(
      page.getByRole("heading", { name: t("inbox.sections.organization") }),
    ).toBeVisible();
    await use(page);
    expect(violations).toEqual([]);
  },
});
