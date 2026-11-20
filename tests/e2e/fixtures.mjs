import { readFile, readdir } from "node:fs/promises";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { expect, test as base } from "@playwright/test";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { unstable_getMiniflareWorkerOptions } from "wrangler";

import {
  testEmailFrom,
  testResendKey,
  testSecretsKey,
  testSetupToken,
} from "../integration/auth-fixture.ts";
import { externalWorkers, workersAiBinding } from "../integration/external-workers.ts";

const owner = {
  name: "Responsable des formulaires",
  email: "responsable@example.test",
  password: "playwright-local-password-42",
};

const externalSite = `
export default {
  fetch(request, env) {
    const url = new URL(request.url);
    const formId = url.searchParams.get("form");
    if (url.pathname === "/merci") {
      return new Response('<!doctype html><html lang="fr"><meta charset="utf-8"><h1>Merci de votre message</h1></html>', {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (url.pathname !== "/contact" || !formId) return new Response(null, { status: 404 });
    const action = env.DASHBOARD_ORIGIN + "/f/" + encodeURIComponent(formId);
    const company = url.searchParams.has("piege") ? "robot" : "";
    return new Response(\`<!doctype html><html lang="fr"><meta charset="utf-8"><h1>Nous contacter</h1>
      <form method="post" action="\${action}">
        <label>Votre message <textarea name="message" required></textarea></label>
        <input type="hidden" name="fixture-verdict" value="accept">
        <input name="societe" value="\${company}" hidden tabindex="-1" autocomplete="off">
        <button>Envoyer le message</button>
      </form></html>\`, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
};
`;

export const test = base.extend({
  dashboardOrigin: async ({ request }, use) => {
    const {
      workerOptions: { modulesRules: _rules, ...workerOptions },
    } = unstable_getMiniflareWorkerOptions("./dist/rondyr/wrangler.json");
    const files = await readdir("./dist/rondyr", { recursive: true });
    const chunks = files.filter((file) => file !== "index.js" && file.endsWith(".js"));
    const runtime = new Miniflare(
      convertV4MiniflareOptions({
        host: "127.0.0.1",
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
              BETTER_AUTH_SECRET: "playwright-local-better-auth-secret-42",
              RONDYR_SETUP_TOKEN: testSetupToken,
              RONDYR_SECRETS_KEY: testSecretsKey,
              RESEND_API_KEY: testResendKey,
              RONDYR_EMAIL_FROM: testEmailFrom,
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
      const setup = await request.post(`${origin}/api/setup`, {
        headers: { authorization: `Bearer ${testSetupToken}` },
        data: owner,
      });
      expect(setup.status(), "POST /api/setup").toBe(201);
      await use(origin);
    } finally {
      await runtime.dispose();
    }
  },

  externalOrigin: async ({ dashboardOrigin }, use) => {
    const runtime = new Miniflare(
      convertV4MiniflareOptions({
        host: "127.0.0.1",
        port: 0,
        https: true,
        modules: true,
        script: externalSite,
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
    const headers = await readFile("public/_headers", "utf8");
    const policy = headers.match(/^\s*Content-Security-Policy: (.+)$/mu)?.[1];
    expect(policy, "CSP in public/_headers").toBeTruthy();
    const response = await page.goto(dashboardOrigin);
    expect(await response?.headerValue("content-security-policy")).toBe(policy);
    await page.getByRole("textbox", { name: "Adresse e-mail" }).fill(owner.email);
    // Password inputs have no implicit ARIA role.
    await page.getByLabel("Mot de passe").fill(owner.password);
    await page.getByRole("button", { name: "Se connecter", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Boîte de réception" })).toBeVisible();
    await use(page);
    expect(violations).toEqual([]);
  },
});
