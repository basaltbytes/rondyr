import { expect } from "@playwright/test";

import { discord } from "../../src/domain/deliveries/connectors/discord.ts";
import { slack } from "../../src/domain/deliveries/connectors/slack.ts";
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

test("add destinations, confirm a recipient, send a test and retry a failed webhook", async ({
  dashboard: page,
  context,
  externalOrigin,
  sentEmails,
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
  await expect(destination.getByText(t("inbox.emails.statuses.pending"))).toBeVisible();
  // The owner of the address confirms it from the link of the email that Rondyr sent.
  const [confirmation] = await sentEmails(email);
  const link = confirmation.text.match(/https?:\/\/\S+\/confirm-recipient#[\w-]{43}/u)?.[0];
  expect(link).toBeDefined();
  const mailbox = await context.newPage();
  await mailbox.goto(link);
  await mailbox.getByRole("button", { name: t("recipientConfirmation.confirm") }).click();
  await expect(
    mailbox.getByRole("heading", { name: t("recipientConfirmation.confirmed.title") }),
  ).toBeVisible();
  await mailbox.close();
  await openSection(page, t("inbox.sections.forms"));
  await openSection(page, t("inbox.sections.destinations"));
  await expect(destination.getByText(t("inbox.emails.statuses.confirmed"))).toBeVisible();
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

test("add a Discord connector, correct a refused setting, test it and see its delivery", async ({
  dashboard: page,
  context,
  externalOrigin,
}) => {
  await createOrganization(page);
  await openSection(page, t("inbox.sections.forms"));
  const endpoint = await publicFormUrl(page, formName);
  await openSection(page, t("inbox.sections.destinations"));
  const connectors = page.getByRole("region", {
    name: t("inbox.connectors.label", { name: formName }),
  });
  await expect(connectors.getByText(t("inbox.connectors.empty"))).toBeVisible();
  const channel = "Sales channel";
  // The fake Discord answers by the last part of the path, which is the token of the webhook.
  const webhookId = "3000000001";
  const urlLabel = t("inbox.connectors.types.discord.fields.webhookUrl.label");
  const name = connectors.getByRole("textbox", { name: t("inbox.connectors.name"), exact: true });
  const url = connectors.getByLabel(urlLabel, { exact: true });
  const add = connectors.getByRole("button", { name: t("inbox.connectors.add") });
  await name.fill(channel);
  // The name stays as typed when the service changes.
  const service = connectors.getByRole("combobox", { name: t("inbox.connectors.service") });
  await service.selectOption(slack.type);
  await service.selectOption(discord.type);
  await expect(name).toHaveValue(channel);
  await url.fill("https://webhooks.example.test/not-discord");
  await add.click();
  await expect(connectors.getByRole("alert")).toHaveText(
    t("inbox.connectors.refusals.invalid", { field: urlLabel }),
  );
  // A refused form keeps what was typed.
  await expect(name).toHaveValue(channel);
  await url.fill(`https://discord.com/api/webhooks/${webhookId}/ok`);
  await add.click();
  const destination = connectors.getByRole("listitem").filter({ hasText: channel });
  await expect(destination).toBeVisible();
  await expect(
    destination.getByText(t("inbox.connectors.secretSaved", { label: urlLabel })),
  ).toBeVisible();
  // The form is empty again, and the page shows the webhook URL nowhere.
  await expect(name).toHaveValue("");
  await expect(page.getByText(webhookId)).toHaveCount(0);
  await destination.getByRole("button", { name: t("inbox.destinations.test.send") }).click();
  await expect(destination.getByRole("status")).toContainText(
    t("inbox.destinations.test.delivered"),
  );

  const site = await context.newPage();
  await openContact(site, externalOrigin, endpoint);
  const message = "Request sent to a Discord channel";
  expect((await submitContact(site, endpoint, message)).status()).toBe(202);
  const reader = await openSubmission(page, t("inbox.folders.accepted"), message);
  const history = reader.getByRole("region", { name: t("inbox.deliveries.label") });
  const delivery = history.getByRole("listitem").filter({
    hasText: t("inbox.deliveries.connector", { service: discord.label, name: channel }),
  });
  const refresh = history.getByRole("button", { name: t("inbox.deliveries.refresh") });
  await expect(async () => {
    await refresh.click();
    await expect(delivery.getByText(t("status.deliveries.delivered"), { exact: true })).toBeVisible(
      { timeout: 500 },
    );
  }).toPass({ timeout: 10_000 });
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

test("retry a stuck submission from the processing status", async ({
  dashboard: page,
  database,
}) => {
  await createOrganization(page);
  // The Cron marks an event stuck after an hour of publications without a hand-off.
  const form = await database
    .prepare("SELECT id, organization_id FROM forms WHERE name = ?")
    .bind(formName)
    .first();
  const submissionId = crypto.randomUUID();
  const message = "Request stuck before classification";
  const now = Date.now();
  await database.batch([
    database
      .prepare(
        "INSERT INTO submissions (id, organization_id, form_id, fields, received_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        submissionId,
        form.organization_id,
        form.id,
        JSON.stringify({ message, "fixture-verdict": "accept" }),
        now,
      ),
    database
      .prepare(
        "INSERT INTO outbox_events (submission_id, published_at, publication_count, stuck_at) VALUES (?, ?, 12, ?)",
      )
      .bind(submissionId, now, now),
  ]);

  await openSection(page, t("operations.title"), t("inbox.navigation.operations"));
  const status = page.getByRole("region", {
    name: t("operations.organization", { name: organizationName }),
  });
  await expect(status).toContainText(figure(t("operations.queue.stuck"), 1));
  const stuck = status.getByRole("region", { name: t("operations.stuck.title") });
  const row = stuck.getByRole("listitem").filter({ hasText: submissionId });
  await expect(row).toContainText(formName);
  await expect(stuck).not.toContainText(message);
  await row.getByRole("button", { name: t("operations.stuck.retry") }).click();

  await expect(status).toContainText(figure(t("operations.queue.stuck"), 0));
  await expect(stuck).toHaveCount(0);
  await openSubmission(page, t("inbox.folders.accepted"), message);
});

test("send a message back to the filter after an analysis error", async ({
  dashboard: page,
  request,
}) => {
  await createOrganization(page);
  await openSection(page, t("inbox.sections.forms"));
  const endpoint = await publicFormUrl(page, formName);
  // The fake model fails on this message once, then accepts it.
  const message = "Request analyzed after an outage";
  const posted = await request.post(endpoint.href, {
    data: { message, "fixture-verdict": "accept-after-error" },
  });
  expect(posted.status()).toBe(202);

  const reader = await openSubmission(page, t("inbox.folders.quarantined"), message);
  await expect(reader).toContainText(t("status.reasons.classification-error"));
  await reader.getByRole("button", { name: t("inbox.reader.reclassify") }).click();
  await expect(reader.getByText(message, { exact: true })).toHaveCount(0);
  await openSubmission(page, t("inbox.folders.accepted"), message);
});

test("keep a message in quarantine when the daily classification quota is used up", async ({
  dashboard: page,
  request,
  database,
}) => {
  await createOrganization(page);
  await openSection(page, t("inbox.sections.forms"));
  const endpoint = await publicFormUrl(page, formName);
  const message = "Request analyzed once the quota allows it";
  const posted = await request.post(endpoint.href, {
    data: { message, "fixture-verdict": "accept-after-error" },
  });
  expect(posted.status()).toBe(202);
  const reader = await openSubmission(page, t("inbox.folders.quarantined"), message);
  await expect(reader).toContainText(t("status.reasons.classification-error"));

  // The message took the day's only classification at intake.
  await database
    .prepare(
      "UPDATE organizations SET daily_classification_limit = 1 WHERE id = (SELECT organization_id FROM forms WHERE name = ?)",
    )
    .bind(formName)
    .run();
  await reader.getByRole("button", { name: t("inbox.reader.reclassify") }).click();
  await expect(reader.getByRole("alert")).toHaveText(
    t("inbox.reader.problems.classificationQuotaReached"),
  );
  await expect(reader).toContainText(t("status.reasons.classification-error"));
  await expect(reader.getByRole("button", { name: t("inbox.reader.reclassify") })).toBeEnabled();
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

test("invite a reviewer, who creates an account from the link and sees no settings", async ({
  dashboard: page,
  browser,
}) => {
  await createOrganization(page);
  await openSection(page, t("inbox.sections.members"));
  const reviewer = { name: "Second reviewer", email: "reviewer@example.test" };
  await page.getByRole("textbox", { name: t("inbox.members.email") }).fill(reviewer.email);
  await page.getByRole("button", { name: t("inbox.members.invite"), exact: true }).click();
  await expect(
    page.getByText(t("inbox.members.emails.sent", { email: reviewer.email })),
  ).toBeVisible();
  const link = await page.getByText(/\/invitation#[A-Za-z0-9_-]{43}$/u).innerText();
  await expect(
    page.getByRole("list", { name: t("inbox.members.pending") }).getByText(reviewer.email),
  ).toBeVisible();

  const context = await browser.newContext();
  const invited = await context.newPage();
  await invited.goto(link);
  await expect(
    invited.getByRole("heading", {
      name: t("invitation.title", { organization: organizationName }),
    }),
  ).toBeVisible();
  await invited.getByRole("textbox", { name: t("invitation.name") }).fill(reviewer.name);
  await invited.getByLabel(t("invitation.password")).fill("playwright-reviewer-password");
  await invited.getByRole("button", { name: t("invitation.createAndJoin") }).click();
  await expect(
    invited.getByRole("button", {
      name: t("inbox.organizations.switcher", { name: organizationName }),
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    invited.getByRole("navigation", { name: t("inbox.navigation.settings"), exact: true }),
  ).toHaveCount(0);
  await invited.goto(link);
  await expect(invited.getByRole("heading", { name: t("invitation.invalidTitle") })).toBeVisible();
  await context.close();

  await page.reload();
  await openSection(page, t("inbox.sections.members"));
  await expect(
    page.getByRole("combobox", { name: t("inbox.members.roleOf", { name: reviewer.name }) }),
  ).toHaveValue("reviewer");
  await expect(page.getByText(t("inbox.members.noInvitations"))).toBeVisible();
});

test("count the API tokens of a member before removing it, and confirm before stepping down", async ({
  dashboard: page,
  browser,
}) => {
  await createOrganization(page);
  await openSection(page, t("inbox.sections.members"));
  const second = { name: "Second admin", email: "second-admin@example.test" };
  await page.getByRole("textbox", { name: t("inbox.members.email") }).fill(second.email);
  await page
    .getByRole("combobox", { name: t("inbox.members.role"), exact: true })
    .selectOption("admin");
  await page.getByRole("button", { name: t("inbox.members.invite"), exact: true }).click();
  const link = await page.getByText(/\/invitation#[A-Za-z0-9_-]{43}$/u).innerText();

  // The second admin joins and creates a token for a website.
  const context = await browser.newContext();
  const invited = await context.newPage();
  await invited.goto(link);
  await invited.getByRole("textbox", { name: t("invitation.name") }).fill(second.name);
  await invited.getByLabel(t("invitation.password")).fill("playwright-second-admin-password");
  await invited.getByRole("button", { name: t("invitation.createAndJoin") }).click();
  await openSection(invited, t("inbox.sections.apiTokens"));
  await invited.getByRole("textbox", { name: t("inbox.apiTokens.name") }).fill("Website");
  await invited.getByRole("button", { name: t("inbox.apiTokens.create"), exact: true }).click();
  await expect(invited.getByText(/^rdr_[A-Za-z0-9_-]{43}$/u)).toBeVisible();
  await context.close();

  await page.reload();
  await openSection(page, t("inbox.sections.members"));
  const remove = page.getByRole("button", {
    name: t("inbox.members.removeLabel", { name: second.name }),
  });
  await remove.click();
  const removal = page.getByRole("alertdialog", { name: t("inbox.members.confirmTitle") });
  await expect(removal.getByText(t("inbox.members.confirmTokens", { count: 1 }))).toBeVisible();
  await removal.getByRole("button", { name: t("common.cancel"), exact: true }).click();
  await expect(remove).toBeFocused();

  const ownRole = page.getByRole("combobox", {
    name: t("inbox.members.roleOf", { name: owner.name }),
  });
  await ownRole.selectOption("reviewer");
  const stepDown = page.getByRole("alertdialog", { name: t("inbox.members.stepDownTitle") });
  await stepDown.getByRole("button", { name: t("common.cancel"), exact: true }).click();
  await expect(ownRole).toHaveValue("admin");
  await ownRole.selectOption("reviewer");
  await stepDown.getByRole("button", { name: t("inbox.members.stepDown"), exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: t("inbox.navigation.settings"), exact: true }),
  ).toHaveCount(0);
});

test("reset a forgotten password from the sign-in screen", async ({
  page,
  dashboardOrigin,
  sentEmails,
}) => {
  await page.goto(dashboardOrigin);
  await page.getByRole("button", { name: t("authentication.signIn.forgotPassword") }).click();
  await page.getByRole("textbox", { name: t("authentication.signIn.email") }).fill(owner.email);
  await page.getByRole("button", { name: t("authentication.passwordReset.submit") }).click();
  await expect(
    page.getByText(t("authentication.passwordReset.sent", { email: owner.email })),
  ).toBeVisible();
  const linkPattern = /https?:\/\/\S+\/reset-password#[\w-]{43}/u;
  await expect
    .poll(async () => (await sentEmails(owner.email)).some(({ text }) => linkPattern.test(text)))
    .toBe(true);
  const emails = await sentEmails(owner.email);
  const link = emails.at(-1).text.match(linkPattern)[0];

  const password = "playwright-new-password-43";
  await page.goto(link);
  await page.getByLabel(t("passwordReset.password")).fill(password);
  await page.getByRole("button", { name: t("passwordReset.submit") }).click();
  await expect(
    page.getByRole("heading", { name: t("passwordReset.changed.title"), exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: t("passwordReset.signIn") }).click();
  await page.getByRole("textbox", { name: t("authentication.signIn.email") }).fill(owner.email);
  await page.getByLabel(t("authentication.signIn.password")).fill(password);
  await page.getByRole("button", { name: t("authentication.signIn.submit"), exact: true }).click();
  await expect(page.getByRole("heading", { name: t("inbox.sections.organization") })).toBeVisible();
});

test("search the messages, export the list, delete a message and keep messages 30 days", async ({
  dashboard: page,
}) => {
  await createOrganization(page);
  await openSection(page, t("inbox.sections.forms"));
  const endpoint = await publicFormUrl(page, formName);
  for (const message of ["The needle is here", "Only hay in this one"]) {
    const posted = await page.request.post(endpoint.href, {
      data: { message, "fixture-verdict": "accept" },
    });
    expect(posted.status()).toBe(202);
  }
  await openSubmission(page, t("inbox.folders.accepted"), "Only hay in this one");

  const list = page.getByRole("region", { name: t("inbox.list.label") });
  await list.getByRole("searchbox", { name: t("inbox.list.search.label") }).fill("NEEDLE");
  await list.getByRole("searchbox", { name: t("inbox.list.search.label") }).press("Enter");
  await expect(list.getByRole("button").filter({ hasText: "The needle is here" })).toBeVisible();
  await expect(list.getByRole("button").filter({ hasText: "Only hay in this one" })).toHaveCount(0);
  const csv = list.getByRole("link", { name: t("inbox.list.export.csv"), exact: true });
  const exported = await page.request.get(new URL(await csv.getAttribute("href"), endpoint).href);
  expect(exported.headers()["cache-control"]).toBe("no-store");
  const text = await exported.text();
  expect(text).toContain("The needle is here");
  expect(text).not.toContain("Only hay in this one");

  const reader = await openMessage(page, "The needle is here");
  const remove = reader.getByRole("button", { name: t("inbox.reader.delete.action") });
  await remove.click();
  const confirmation = page.getByRole("alertdialog", { name: t("inbox.reader.delete.title") });
  await confirmation.getByRole("button", { name: t("common.cancel"), exact: true }).click();
  await expect(remove).toBeFocused();
  await remove.click();
  await confirmation
    .getByRole("button", { name: t("inbox.reader.delete.confirm"), exact: true })
    .click();
  await expect(list.getByRole("button").filter({ hasText: "The needle is here" })).toHaveCount(0);
  await expect(
    list.getByRole("heading", { name: t("inbox.list.search.empty", { search: "NEEDLE" }) }),
  ).toBeVisible();

  await openSection(page, t("inbox.sections.retention"));
  const accepted = page.getByRole("spinbutton", { name: t("inbox.retention.accepted") });
  await accepted.fill("30");
  await page.getByRole("button", { name: t("common.save"), exact: true }).click();
  await expect(page.getByText(t("inbox.retention.outcomes.saved"))).toBeVisible();
  await page.reload();
  await openSection(page, t("inbox.sections.retention"));
  await expect(accepted).toHaveValue("30");
  await expect(page.getByRole("spinbutton", { name: t("inbox.retention.quarantine") })).toHaveValue(
    "",
  );
});
