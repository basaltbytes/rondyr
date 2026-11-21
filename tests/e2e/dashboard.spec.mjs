import { expect } from "@playwright/test";

import { confirmationPages } from "../../src/domain/submissions/confirmation-page.ts";
import { externalSite, frenchT, owner, t, test } from "./fixtures.mjs";

const organizationName = "Rondyr Workshop";
const formName = "Visitor contact";
// Under 64rem the dashboard shows one pane at a time and its navigation is a drawer.
const narrowScreen = { width: 390, height: 844 };

async function createOrganization(page) {
  await page
    .getByRole("textbox", { name: t("inbox.setup.organization"), exact: true })
    .fill(organizationName);
  await page.getByRole("textbox", { name: t("inbox.setup.firstForm") }).fill(formName);
  await page.getByRole("button", { name: t("inbox.setup.submit") }).click();
  await expect(
    page.getByRole("button", {
      name: t("inbox.organizations.switcher", { name: organizationName }),
      exact: true,
    }),
  ).toBeVisible();
}

/** Open a page from a group of the sidebar. Without a group, a page of the settings. */
async function openSection(page, name, group = t("inbox.navigation.settings")) {
  await page
    .getByRole("navigation", { name: group, exact: true })
    .getByRole("button", { name, exact: true })
    .click();
}

function settingsFor(page, name) {
  return page.getByRole("region", { name: t("inbox.forms.settings", { name }), exact: true });
}

async function publicFormUrl(page, name) {
  const settings = settingsFor(page, name);
  const url = settings.getByText(/^https?:\/\/[^/]+\/f\//u);
  await expect(url).toBeVisible();
  return new URL(await url.innerText());
}

async function openContact(site, externalOrigin, endpoint, trapFilled = false) {
  const contact = new URL("/contact", externalOrigin);
  contact.searchParams.set("form", decodeURIComponent(endpoint.pathname.split("/").at(-1)));
  if (trapFilled) contact.searchParams.set(externalSite.honeypotParameter, "filled");
  await site.goto(contact.href);
  await expect(site.getByRole("heading", { name: externalSite.contactHeading })).toBeVisible();
}

async function submitContact(site, endpoint, message) {
  await site.getByRole("textbox", { name: externalSite.messageField }).fill(message);
  const posted = site.waitForResponse(
    (response) => response.url() === endpoint.href && response.request().method() === "POST",
  );
  await site.getByRole("button", { name: externalSite.submitButton }).click();
  return posted;
}

async function addOrigin(region, origin) {
  await region.getByRole("textbox", { name: t("inbox.origins.origin"), exact: true }).fill(origin);
  await region.getByRole("button", { name: t("inbox.origins.add") }).click();
  await expect(region.getByText(origin, { exact: true })).toBeVisible();
}

async function sendJson(site, endpoint) {
  return site.evaluate(async (url) => {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Request sent as JSON", "fixture-verdict": "accept" }),
      });
      return response.status;
    } catch (error) {
      if (error instanceof TypeError) return "fetch refused";
      throw error;
    }
  }, endpoint.href);
}

function accountMenu(page) {
  return page.getByRole("button", {
    name: t("authentication.account.label", { email: owner.email }),
    exact: true,
  });
}

/** The button of a folder in the navigation, which is the sidebar or the drawer. */
function folderButton(navigation, folder) {
  return (
    navigation
      .getByRole("navigation", { name: t("inbox.navigation.messages"), exact: true })
      // The name of a folder ends with the number of its messages.
      .getByRole("button", { name: new RegExp(`^${RegExp.escape(folder)}`, "u") })
  );
}

/** Open a message from a folder of the sidebar, once the list shows it. */
async function openSubmission(page, folder, message) {
  await folderButton(page, folder).click();
  return openMessage(page, message);
}

/** Open a message of the folder on screen, once the list shows it. */
async function openMessage(page, message) {
  const list = page.getByRole("region", { name: t("inbox.list.label") });
  const row = list.getByRole("button").filter({ hasText: message });
  await expect(async () => {
    await list.getByRole("button", { name: t("common.refresh"), exact: true }).click();
    await expect(row).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 10_000 });
  await row.click();
  const reader = page.getByRole("region", { name: t("inbox.reader.label") });
  await expect(reader.getByText(message, { exact: true })).toBeVisible();
  return reader;
}

/** A figure of the status page as its text reads: the label, then the value. */
function figure(label, value) {
  return new RegExp(`${RegExp.escape(label)}\\s*${value}`, "u");
}

test("add a domain and remove it after reopening the settings in French", async ({
  dashboard: page,
}) => {
  await createOrganization(page);
  await openSection(page, t("inbox.sections.domains"));
  await expect(page.getByText(t("inbox.domains.empty"))).toBeVisible();
  const domain = "studio.example";
  const hostname = page.getByRole("textbox", { name: t("inbox.domains.hostname") });
  await hostname.fill(`https://${domain}`);
  await hostname.press("Enter");
  await expect(page.getByRole("alert")).toHaveText(t("inbox.domains.invalid"));
  await hostname.fill(domain);
  await hostname.press("Enter");
  await expect(page.getByText(domain, { exact: true })).toBeVisible();

  await accountMenu(page).click();
  await page.getByRole("menuitemradio", { name: t("languages.fr") }).click();
  await page.reload();
  await openSection(page, frenchT("inbox.sections.domains"), frenchT("inbox.navigation.settings"));
  await page
    .getByRole("button", { name: frenchT("inbox.domains.removeLabel", { domain }) })
    .click();
  await expect(page.getByText(frenchT("inbox.domains.empty"))).toBeVisible();
});

test.describe("on a deployment with OpenAI Decisions as the second model", () => {
  test.use({ escalationClassifier: "openai" });

  test("edit the classification policy, then restore the defaults in French", async ({
    dashboard: page,
  }) => {
    await createOrganization(page);
    await accountMenu(page).click();
    await page.getByRole("menuitemradio", { name: t("languages.fr") }).click();
    await page.keyboard.press("Escape");
    const openPolicy = () =>
      openSection(
        page,
        frenchT("inbox.sections.classification"),
        frenchT("inbox.navigation.settings"),
      );
    await openPolicy();
    const mode = page.getByRole("combobox", { name: frenchT("inbox.policy.thresholdMode") });
    const offTopic = page.getByRole("combobox", { name: frenchT("inbox.policy.offTopic") });
    const escalation = page.getByRole("switch", { name: frenchT("inbox.policy.escalation") });
    const relevance = page.getByRole("spinbutton", {
      name: frenchT("inbox.policy.thresholds.lowRelevance"),
    });
    const ambiguous = page.getByRole("spinbutton", {
      name: frenchT("inbox.policy.thresholds.ambiguous"),
    });
    const save = page.getByRole("button", { name: frenchT("inbox.policy.save") });
    await expect(relevance).toHaveValue("0.5");
    await expect(relevance).toHaveAccessibleDescription(frenchT("inbox.policy.hints.lowRelevance"));
    await expect(ambiguous).toHaveAccessibleDescription(frenchT("inbox.policy.hints.ambiguous"));
    await expect(escalation).not.toBeChecked();
    await expect(escalation).toHaveAccessibleDescription(
      frenchT("inbox.policy.escalationHint", { model: frenchT("inbox.policy.models.openai") }),
    );
    await mode.selectOption({ label: frenchT("inbox.policy.custom") });
    await ambiguous.fill("0.9");
    await save.click();
    await expect(page.getByRole("alert")).toHaveText(frenchT("inbox.policy.invalid"));
    await ambiguous.fill("0.35");
    await relevance.fill("0.62");
    await offTopic.selectOption({ label: frenchT("inbox.policy.accept") });
    await escalation.press("Space");
    await save.click();
    await expect(page.getByText(frenchT("inbox.policy.saved"))).toBeVisible();

    await page.reload();
    await openPolicy();
    await expect(relevance).toHaveValue("0.62");
    await expect(offTopic).toHaveValue("accept");
    await expect(escalation).toBeChecked();
    await mode.selectOption({ label: frenchT("inbox.policy.defaults") });
    await offTopic.selectOption({ label: frenchT("inbox.policy.defaults") });
    await escalation.press("Space");
    await save.click();
    await expect(page.getByText(frenchT("inbox.policy.saved"))).toBeVisible();

    await page.reload();
    await openPolicy();
    await expect(relevance).toHaveValue("0.5");
    await expect(offTopic).toHaveValue("defaults");
    await expect(escalation).not.toBeChecked();
  });
});

test("keep the stored escalation choice when saving without a second model", async ({
  dashboard: page,
}) => {
  await createOrganization(page);
  await openSection(page, t("inbox.sections.classification"));
  const escalation = page.getByRole("switch", { name: t("inbox.policy.escalation") });
  const offTopic = page.getByRole("combobox", { name: t("inbox.policy.offTopic") });
  await expect(escalation).toBeDisabled();
  await expect(escalation).not.toBeChecked();
  await expect(escalation).toHaveAccessibleDescription(t("inbox.policy.escalationUnavailable"));

  // A choice stored while the deployment had a second model, or sent through the API.
  const stored = await page.evaluate(async (name) => {
    const organizations = await fetch("/api/organizations").then((response) => response.json());
    const { id } = organizations.find((organization) => organization.name === name);
    const response = await fetch(
      `/api/organizations/${encodeURIComponent(id)}/classification-policy`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ escalation: true }),
      },
    );
    return response.status;
  }, organizationName);
  expect(stored).toBe(204);

  await page.reload();
  await openSection(page, t("inbox.sections.classification"));
  await expect(escalation).toBeChecked();
  await expect(escalation).toBeDisabled();
  await offTopic.selectOption({ label: t("inbox.policy.accept") });
  await page.getByRole("button", { name: t("inbox.policy.save") }).click();
  await expect(page.getByText(t("inbox.policy.saved"))).toBeVisible();

  await page.reload();
  await openSection(page, t("inbox.sections.classification"));
  await expect(offTopic).toHaveValue("accept");
  await expect(escalation).toBeChecked();
});

test("sign in, create an organization and manage its forms, then sign out", async ({
  dashboard: page,
  context,
  externalOrigin,
}) => {
  await createOrganization(page);
  await openSection(page, t("inbox.sections.forms"));
  const addedName = "Quote requests";
  const renamed = "Business quotes";
  await page.getByRole("button", { name: t("inbox.forms.new"), exact: true }).click();
  await page.getByRole("textbox", { name: t("inbox.forms.name") }).fill(addedName);
  await page.getByRole("button", { name: t("inbox.forms.add") }).click();
  const beforeRename = await publicFormUrl(page, addedName);
  await settingsFor(page, addedName)
    .getByRole("button", { name: t("inbox.forms.edit"), exact: true })
    .click();
  const edit = settingsFor(page, addedName);
  await edit.getByRole("textbox", { name: t("inbox.forms.name") }).fill(renamed);
  await edit.getByRole("button", { name: t("common.save"), exact: true }).click();
  const endpoint = await publicFormUrl(page, renamed);
  expect(endpoint.href).toBe(beforeRename.href);

  const settings = settingsFor(page, renamed);
  const suspend = settings.getByRole("button", { name: t("inbox.forms.suspension.suspend") });
  const reactivate = settings.getByRole("button", {
    name: t("inbox.forms.suspension.reactivate"),
  });
  await suspend.click();
  await settings.getByRole("button", { name: t("inbox.forms.suspension.confirm") }).click();
  await expect(reactivate).toBeVisible();
  const site = await context.newPage();
  await openContact(site, externalOrigin, endpoint);
  expect((await submitContact(site, endpoint, "Request during the suspension")).status()).toBe(403);
  await reactivate.click();
  await expect(suspend).toBeVisible();
  await openContact(site, externalOrigin, endpoint);
  expect((await submitContact(site, endpoint, "Request after the reactivation")).status()).toBe(
    202,
  );

  await accountMenu(page).click();
  await page.getByRole("menuitem", { name: t("authentication.signOut.submit") }).click();
  const signIn = page.getByRole("heading", { name: t("authentication.signIn.title") });
  await expect(signIn).toBeVisible();
  await page.reload();
  await expect(signIn).toBeVisible();
  await expect(page.getByRole("navigation", { name: t("inbox.navigation.messages") })).toHaveCount(
    0,
  );
});

test("save Turnstile keys and copy the widget HTML from Forms", async ({
  dashboard: page,
  context,
}) => {
  await createOrganization(page);
  await openSection(page, t("inbox.sections.forms"));
  const settings = settingsFor(page, formName);
  const siteKey = "sample-widget-site-key";
  const secretKey = "sample-widget-secret";
  const site = settings.getByLabel(t("inbox.forms.turnstile.siteKey"), { exact: true });
  const secret = settings.getByLabel(t("inbox.forms.turnstile.secretKey"), { exact: true });
  const save = settings.getByRole("button", { name: t("inbox.forms.turnstile.save") });
  const copy = settings.getByRole("button", { name: t("inbox.forms.turnstile.copy") });
  // The Siteverify fixture does not know a secret key that starts with refused-.
  await site.fill(siteKey);
  await secret.fill("refused-widget-secret");
  await save.click();
  await expect(settings.getByText(t("inbox.forms.turnstile.secretKeyRefused"))).toBeVisible();
  await expect(copy).toBeHidden();

  await site.fill(siteKey);
  await secret.fill(secretKey);
  await save.click();

  await expect(copy).toBeVisible();
  await expect(secret).toHaveValue("");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await copy.click();
  await expect(settings.getByText(t("inbox.forms.turnstile.copied"))).toBeVisible();
  const html = await page.evaluate(() => navigator.clipboard.readText());
  expect(html).toContain(`data-sitekey="${siteKey}"`);
  expect(html).toContain("https://challenges.cloudflare.com/turnstile/v0/api.js");
  expect(html).not.toContain(secretKey);
});

test("warn in Forms when Cloudflare no longer accepts the stored Turnstile key", async ({
  dashboard: page,
}) => {
  await createOrganization(page);
  await openSection(page, t("inbox.sections.forms"));
  const settings = settingsFor(page, formName);
  await settings
    .getByLabel(t("inbox.forms.turnstile.siteKey"), { exact: true })
    .fill("sample-widget-site-key");
  // The Siteverify fixture knows a secret key that starts with revoked- only on its first check.
  await settings
    .getByLabel(t("inbox.forms.turnstile.secretKey"), { exact: true })
    .fill("revoked-widget-secret");

  await settings.getByRole("button", { name: t("inbox.forms.turnstile.save") }).click();

  const warning = settings
    .getByRole("alert")
    .filter({ hasText: t("inbox.forms.turnstile.key.off") });
  await expect(warning).toContainText(t("inbox.forms.turnstile.key.refused"));
});

test("show today's usage and retain changed daily quotas", async ({ dashboard: page, request }) => {
  await createOrganization(page);
  await openSection(page, t("inbox.sections.forms"));
  const endpoint = await publicFormUrl(page, formName);
  const received = await request.post(endpoint.href, {
    data: { message: "Daily usage example", "fixture-verdict": "accept" },
  });
  expect(received.status()).toBe(202);
  await openSection(page, t("inbox.sections.quotas"));
  const submissions = page.getByRole("spinbutton", { name: t("inbox.quotas.submissions") });
  const classifications = page.getByRole("spinbutton", { name: t("inbox.quotas.classifications") });
  await expect(submissions).toHaveAccessibleDescription(
    t("inbox.quotas.used", { used: "1", limit: "2,000" }),
  );
  await submissions.fill("10");
  await classifications.fill("5");
  await page.getByRole("button", { name: t("common.save"), exact: true }).click();
  await expect(page.getByText(t("inbox.quotas.saved"))).toBeVisible();

  await page.reload();
  await openSection(page, t("inbox.sections.quotas"));
  await expect(submissions).toHaveAccessibleDescription(
    t("inbox.quotas.used", { used: "1", limit: "10" }),
  );
  await expect(classifications).toHaveValue("5");
  // Junk has its own count, under the same limit as the other submissions.
  await expect(page.getByRole("region", { name: t("inbox.quotas.junk") })).toContainText(
    t("inbox.quotas.used", { used: "0", limit: "10" }),
  );
});

test("confirm and redirect HTML submissions, then refuse JSON from a removed origin", async ({
  dashboard: page,
  context,
  dashboardOrigin,
  externalOrigin,
}) => {
  await createOrganization(page);
  await openSection(page, t("inbox.sections.forms"));
  const endpoint = await publicFormUrl(page, formName);
  const site = await context.newPage();
  await openContact(site, externalOrigin, endpoint);
  const confirmation = await submitContact(site, endpoint, "Request with confirmation");
  expect(confirmation.status()).toBe(202);
  await expect(site.getByRole("heading", { name: confirmationPages.en.title })).toBeVisible();
  await expect(site).toHaveURL(endpoint.href);

  await openSection(page, t("inbox.sections.origins"));
  const origins = page.getByRole("region", { name: t("inbox.origins.label", { name: formName }) });
  await expect(origins.getByText(t("inbox.origins.empty"))).toBeVisible();
  // An empty allowlist admits all origins, so leave another entry in the list.
  await addOrigin(origins, dashboardOrigin);
  await addOrigin(origins, externalOrigin);

  const successUrl = `${externalOrigin}${externalSite.thanksPath}`;
  const settings = settingsFor(page, formName);
  await openSection(page, t("inbox.sections.forms"));
  await settings.getByRole("textbox", { name: t("inbox.forms.redirect.url") }).fill(successUrl);
  await settings.getByRole("button", { name: t("inbox.forms.redirect.save") }).click();
  await expect(settings.getByText(successUrl, { exact: true })).toBeVisible();
  await openContact(site, externalOrigin, endpoint);
  const redirect = await submitContact(site, endpoint, "Request with redirect");
  expect(redirect.status()).toBe(303);
  await expect(site).toHaveURL(successUrl);
  await expect(site.getByRole("heading", { name: externalSite.thanksHeading })).toBeVisible();
  expect(await sendJson(site, endpoint)).toBe(202);

  await settings.getByRole("button", { name: t("inbox.forms.redirect.remove") }).click();
  await expect(settings.getByText(successUrl, { exact: true })).toHaveCount(0);
  await openSection(page, t("inbox.sections.origins"));
  const externalEntry = origins.getByRole("listitem").filter({ hasText: externalOrigin });
  await externalEntry.getByRole("button", { name: t("inbox.origins.remove"), exact: true }).click();
  await expect(externalEntry).toHaveCount(0);
  await expect(origins.getByText(dashboardOrigin, { exact: true })).toBeVisible();
  // Use a new URL so Chromium sends a fresh CORS preflight after removal.
  const afterRemoval = new URL("?origin=removed", endpoint);
  expect(await sendJson(site, afterRemoval)).toBe("fetch refused");
});

test("quarantine a message with a filled honeypot field and review it", async ({
  dashboard: page,
  context,
  externalOrigin,
}) => {
  await createOrganization(page);
  await openSection(page, t("inbox.sections.forms"));
  const endpoint = await publicFormUrl(page, formName);
  const settings = settingsFor(page, formName);
  await settings
    .getByRole("textbox", { name: t("inbox.forms.honeypot.name") })
    .fill(externalSite.honeypotField);
  await settings.getByRole("button", { name: t("inbox.forms.honeypot.save") }).click();
  await expect(
    settings.getByRole("button", { name: t("inbox.forms.honeypot.remove") }),
  ).toBeVisible();

  const site = await context.newPage();
  await openContact(site, externalOrigin, endpoint, true);
  const message = "Request typed with a hidden field filled";
  expect((await submitContact(site, endpoint, message)).status()).toBe(202);
  await expect(site.getByRole("heading", { name: confirmationPages.en.title })).toBeVisible();
  const reader = await openSubmission(page, t("inbox.folders.quarantined"), message);
  await expect(reader.getByText(t("status.reasons.honeypot"), { exact: true })).toBeVisible();
  const accept = t("inbox.reader.acceptAndSend");
  await reader.getByRole("button", { name: accept }).click();
  // An accepted message leaves the folder of the messages to review.
  await expect(reader.getByText(message, { exact: true })).toHaveCount(0);
  const accepted = await openSubmission(page, t("inbox.folders.accepted"), message);
  await expect(accepted.getByText(t("inbox.statuses.accepted"), { exact: true })).toBeVisible();
  await expect(accepted.getByRole("button", { name: accept })).toHaveCount(0);
});

test("add destinations, send a test and retry a failed webhook", async ({
  dashboard: page,
  context,
  externalOrigin,
}) => {
  await createOrganization(page);
  await openSection(page, t("inbox.sections.forms"));
  const endpoint = await publicFormUrl(page, formName);
  const receiver = "https://webhooks.example.test/bad-request-once";
  const email = "team@example.test";
  const sendTest = t("inbox.destinations.test.send");
  const testDelivered = t("inbox.destinations.test.delivered");
  await openSection(page, t("inbox.sections.destinations"));
  const webhooks = page.getByRole("region", {
    name: t("inbox.webhooks.label", { name: formName }),
  });
  await expect(webhooks.getByText(t("inbox.webhooks.empty"))).toBeVisible();
  await webhooks.getByRole("textbox", { name: t("inbox.webhooks.url") }).fill(receiver);
  await webhooks.getByRole("button", { name: t("inbox.webhooks.add") }).click();
  const secret = webhooks.getByText(/^whsec_[\w-]{43}$/u);
  await expect(secret).toBeVisible();
  await webhooks
    .getByRole("button", { name: t("inbox.webhooks.secret.hide"), exact: true })
    .click();
  await expect(secret).toHaveCount(0);
  // Leaving the page and coming back lists the webhook without its secret.
  await openSection(page, t("inbox.sections.forms"));
  await openSection(page, t("inbox.sections.destinations"));
  const webhook = webhooks.getByRole("listitem").filter({ hasText: receiver });
  await expect(webhook).toBeVisible();
  await expect(secret).toHaveCount(0);

  const emails = page.getByRole("region", { name: t("inbox.emails.label", { name: formName }) });
  await expect(emails.getByText(t("inbox.emails.empty"))).toBeVisible();
  await emails.getByRole("textbox", { name: t("inbox.emails.recipients") }).fill(email);
  await emails.getByRole("button", { name: t("inbox.emails.add") }).click();
  const destination = emails.getByRole("listitem").filter({ hasText: email });
  await expect(destination).toBeVisible();
  await destination.getByRole("button", { name: sendTest }).click();
  await expect(destination.getByRole("status")).toContainText(testDelivered);

  const site = await context.newPage();
  await openContact(site, externalOrigin, endpoint);
  const message = "Request with delivery history";
  expect((await submitContact(site, endpoint, message)).status()).toBe(202);
  const reader = await openSubmission(page, t("inbox.folders.accepted"), message);
  const history = reader.getByRole("region", { name: t("inbox.deliveries.label") });
  // Only a delivery names its destination. The attempts listed inside it do not.
  const webhookDelivery = history.getByRole("listitem").filter({ hasText: receiver });
  const refresh = history.getByRole("button", { name: t("inbox.deliveries.refresh") });
  const retry = webhookDelivery.getByRole("button", { name: t("inbox.deliveries.retry") });
  const delivered = t("status.deliveries.delivered");
  await expect(async () => {
    await refresh.click();
    await expect(retry).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 10_000 });
  await expect(
    webhookDelivery.getByText(t("status.deliveries.failed"), { exact: true }),
  ).toBeVisible();
  await expect(webhookDelivery).toContainText("400");
  await webhookDelivery
    .getByText(t("inbox.deliveries.attempts", { count: 1 }), { exact: true })
    .click();
  await expect(webhookDelivery.getByRole("listitem")).toContainText(
    t("inbox.deliveries.outcomes.permanent-failure"),
  );
  await retry.click();
  await expect(async () => {
    await refresh.click();
    await expect(webhookDelivery.getByText(delivered, { exact: true })).toBeVisible({
      timeout: 500,
    });
  }).toPass({ timeout: 10_000 });
  // The list of attempts is still open from the first look.
  await expect(
    webhookDelivery.getByText(t("inbox.deliveries.attempts", { count: 2 }), { exact: true }),
  ).toBeVisible();
  await expect(webhookDelivery.getByRole("listitem")).toHaveCount(2);
  await expect(
    webhookDelivery
      .getByRole("listitem")
      .filter({ hasText: t("inbox.deliveries.attempt", { number: 2 }) }),
  ).toContainText(t("inbox.deliveries.outcomes.delivered"));
  await expect(retry).toHaveCount(0);
  const emailDelivery = history
    .getByRole("listitem")
    .filter({ hasText: t("inbox.deliveries.email", { recipients: email }) });
  await expect(emailDelivery.getByText(delivered, { exact: true })).toBeVisible();
  await expect(
    emailDelivery.getByText(t("inbox.deliveries.attempts", { count: 1 }), { exact: true }),
  ).toBeVisible();

  await openSection(page, t("inbox.sections.destinations"));
  await webhook.getByRole("button", { name: sendTest }).click();
  await expect(webhook.getByRole("status")).toContainText(testDelivered);
});

test("see a new message in the processing status after refreshing it", async ({
  dashboard: page,
  context,
  externalOrigin,
}) => {
  await createOrganization(page);
  await openSection(page, t("inbox.sections.forms"));
  const endpoint = await publicFormUrl(page, formName);
  await openSection(page, t("operations.title"), t("inbox.navigation.operations"));
  const status = page.getByRole("region", {
    name: t("operations.organization", { name: organizationName }),
  });
  const received = t("operations.lastDay.received");
  await expect(status).toContainText(figure(received, 0));

  const site = await context.newPage();
  await openContact(site, externalOrigin, endpoint);
  expect((await submitContact(site, endpoint, "Request counted in the status")).status()).toBe(202);
  await page.getByRole("button", { name: t("common.refresh"), exact: true }).click();

  await expect(status).toContainText(figure(received, 1));
});

test("narrow a folder to one form, show every form again, and keep the folder unfolded after a reload", async ({
  dashboard: page,
  context,
  externalOrigin,
}) => {
  await createOrganization(page);
  await openSection(page, t("inbox.sections.forms"));
  const contactEndpoint = await publicFormUrl(page, formName);
  const quotes = "Quote requests";
  await page.getByRole("button", { name: t("inbox.forms.new"), exact: true }).click();
  await page.getByRole("textbox", { name: t("inbox.forms.name") }).fill(quotes);
  await page.getByRole("button", { name: t("inbox.forms.add") }).click();
  const quotesEndpoint = await publicFormUrl(page, quotes);
  const site = await context.newPage();
  const question = "Question sent from the contact form";
  const quote = "Estimate asked from the second form";
  await openContact(site, externalOrigin, contactEndpoint);
  expect((await submitContact(site, contactEndpoint, question)).status()).toBe(202);
  await openContact(site, externalOrigin, quotesEndpoint);
  expect((await submitContact(site, quotesEndpoint, quote)).status()).toBe(202);
  const accepted = t("inbox.folders.accepted");
  await openSubmission(page, accepted, question);
  await openMessage(page, quote);
  const list = page.getByRole("region", { name: t("inbox.list.label") });
  const fromContact = list.getByRole("button").filter({ hasText: question });
  const fromQuotes = list.getByRole("button").filter({ hasText: quote });
  const folderForms = t("inbox.folderForms", { folder: accepted });
  const unfold = page.getByRole("button", { name: folderForms, exact: true });
  const forms = page.getByRole("list", { name: folderForms, exact: true });
  // The folder unfolds once the counts say that two forms have a message in it.
  await expect(async () => {
    await list.getByRole("button", { name: t("common.refresh"), exact: true }).click();
    await expect(unfold).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 10_000 });

  await unfold.click();
  // The name of a form's row ends with the number of its messages.
  await forms.getByRole("button", { name: new RegExp(`^${RegExp.escape(quotes)}`, "u") }).click();
  await expect(fromQuotes).toBeVisible();
  await expect(fromContact).toHaveCount(0);

  await list
    .getByRole("button", { name: t("inbox.list.form.remove", { name: quotes }), exact: true })
    .click();
  await expect(fromContact).toBeVisible();
  await expect(fromQuotes).toBeVisible();

  await page.reload();
  await expect(forms).toBeVisible();
});

test("offer no forms under a folder of an organization that has one form", async ({
  dashboard: page,
  context,
  externalOrigin,
}) => {
  await createOrganization(page);
  await openSection(page, t("inbox.sections.forms"));
  const endpoint = await publicFormUrl(page, formName);
  const site = await context.newPage();
  await openContact(site, externalOrigin, endpoint);
  const message = "Request sent to the only form";
  expect((await submitContact(site, endpoint, message)).status()).toBe(202);
  const accepted = t("inbox.folders.accepted");

  await openSubmission(page, accepted, message);

  // The count of the folder shows that the counts of its forms have arrived.
  await expect(folderButton(page, accepted)).toContainText("1");
  await expect(
    page.getByRole("button", { name: t("inbox.folderForms", { folder: accepted }), exact: true }),
  ).toHaveCount(0);
});

test("keep the sidebar collapsed after a reload", async ({ dashboard: page }) => {
  await createOrganization(page);
  const collapsed = page.getByRole("button", { name: t("sidebar.toggle"), expanded: false });
  await page.getByRole("button", { name: t("sidebar.toggle"), expanded: true }).click();
  await expect(collapsed).toBeVisible();

  await page.reload();

  await expect(collapsed).toBeVisible();
});

test("open the navigation as a drawer on a narrow screen and close it by choosing a folder", async ({
  dashboard: page,
}) => {
  await createOrganization(page);
  await page.setViewportSize(narrowScreen);
  const drawer = page.getByRole("dialog", { name: t("inbox.navigation.label") });

  await page.getByRole("button", { name: t("sidebar.toggle"), exact: true }).click();
  await expect(drawer).toBeVisible();
  await folderButton(drawer, t("inbox.folders.accepted")).click();

  await expect(drawer).toBeHidden();
  await expect(page.getByRole("heading", { name: t("inbox.folders.accepted") })).toBeVisible();
});

test("show an open message in place of the list on a narrow screen, and the list again after going back", async ({
  dashboard: page,
  context,
  externalOrigin,
}) => {
  await createOrganization(page);
  await openSection(page, t("inbox.sections.forms"));
  const endpoint = await publicFormUrl(page, formName);
  const site = await context.newPage();
  await openContact(site, externalOrigin, endpoint);
  const message = "Request read on a narrow screen";
  expect((await submitContact(site, endpoint, message)).status()).toBe(202);
  await page.setViewportSize(narrowScreen);
  await page.getByRole("button", { name: t("sidebar.toggle"), exact: true }).click();
  const drawer = page.getByRole("dialog", { name: t("inbox.navigation.label") });
  await folderButton(drawer, t("inbox.folders.accepted")).click();
  const list = page.getByRole("region", { name: t("inbox.list.label") });

  const reader = await openMessage(page, message);
  await expect(list).toBeHidden();
  await reader.getByRole("button", { name: t("inbox.reader.back") }).click();

  await expect(list).toBeVisible();
});

test("keep the language chosen in the account menu after a reload", async ({ dashboard: page }) => {
  await createOrganization(page);
  const frenchSettings = page.getByRole("navigation", {
    name: frenchT("inbox.navigation.settings"),
    exact: true,
  });
  await accountMenu(page).click();
  await page.getByRole("menuitemradio", { name: t("languages.fr") }).click();
  // The menu stays open after a choice and hides the page from the accessibility tree.
  await page.keyboard.press("Escape");
  await expect(frenchSettings).toBeVisible();

  await page.reload();

  await expect(frenchSettings).toBeVisible();
});

test("show the French language of an email destination after leaving the page and coming back", async ({
  dashboard: page,
}) => {
  await createOrganization(page);
  await openSection(page, t("inbox.sections.destinations"));
  const email = "equipe@example.test";
  const emails = page.getByRole("region", { name: t("inbox.emails.label", { name: formName }) });
  await emails.getByRole("textbox", { name: t("inbox.emails.recipients") }).fill(email);
  await emails
    .getByRole("combobox", { name: t("inbox.emails.language") })
    .selectOption({ label: t("languages.fr") });
  await emails.getByRole("button", { name: t("inbox.emails.add") }).click();
  const destination = emails.getByRole("listitem").filter({ hasText: email });
  await expect(destination).toBeVisible();

  await openSection(page, t("inbox.sections.forms"));
  await openSection(page, t("inbox.sections.destinations"));

  await expect(
    destination.getByText(t("inbox.emails.languageValue", { language: t("languages.fr") }), {
      exact: true,
    }),
  ).toBeVisible();
});

test.describe("in a browser that prefers French", () => {
  test.use({ locale: "fr-FR" });

  test("show the sign-in screen in French", async ({ page, dashboardOrigin }) => {
    await page.goto(dashboardOrigin);

    await expect(
      page.getByRole("heading", { name: frenchT("authentication.signIn.title"), exact: true }),
    ).toBeVisible();
  });
});

test("create, copy, and revoke a token that is only displayed once", async ({
  dashboard: page,
}) => {
  await createOrganization(page);
  await openSection(page, t("inbox.sections.apiTokens"));
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const name = "Site inbox";
  await page.getByRole("textbox", { name: t("inbox.apiTokens.name") }).fill(name);
  await page.getByRole("button", { name: t("inbox.apiTokens.create"), exact: true }).click();

  const secret = page.getByText(/^rdr_[A-Za-z0-9_-]{43}$/u);
  await expect(secret).toBeVisible();
  await page.getByRole("button", { name: t("inbox.apiTokens.copy"), exact: true }).click();
  await expect(page.getByText(t("inbox.apiTokens.copied"))).toBeVisible();
  const suffix = (await secret.innerText()).slice(-4);
  expect(
    await page.evaluate(async () => {
      const clipboard = await navigator.clipboard.readText();
      return { format: /^rdr_[A-Za-z0-9_-]{43}$/u.test(clipboard), suffix: clipboard.slice(-4) };
    }),
  ).toEqual({ format: true, suffix });

  await page.reload();
  await openSection(page, t("inbox.sections.apiTokens"));
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  await expect(page.getByText(`••••${suffix}`, { exact: true })).toBeVisible();
  await expect(secret).toHaveCount(0);
  const revoke = page.getByRole("button", { name: t("inbox.apiTokens.revokeLabel", { name }) });
  await revoke.click();
  const confirmation = page.getByRole("alertdialog", { name: t("inbox.apiTokens.confirmTitle") });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: t("common.cancel"), exact: true }).click();
  await expect(revoke).toBeFocused();

  await revoke.click();
  await confirmation
    .getByRole("button", { name: t("inbox.apiTokens.confirm"), exact: true })
    .click();
  await expect(page.getByText(t("inbox.apiTokens.empty"))).toBeVisible();
});
