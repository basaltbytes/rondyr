import { expect } from "@playwright/test";

import { test } from "./fixtures.mjs";

const formName = "Contact visiteurs";

async function createOrganization(page) {
  await page.getByRole("textbox", { name: "Organisation", exact: true }).fill("Atelier Rondyr");
  await page.getByRole("textbox", { name: "Nom du premier formulaire" }).fill(formName);
  await page.getByRole("button", { name: "Créer l’organisation" }).click();
  await expect(page.getByRole("button", { name: /^Organisation : Atelier Rondyr/u })).toBeVisible();
}

/** Open a page from a group of the sidebar, such as "Formulaires" in "Réglages". */
async function openSection(page, name, group = "Réglages") {
  await page
    .getByRole("navigation", { name: group, exact: true })
    .getByRole("button", { name, exact: true })
    .click();
}

function settingsFor(page, name) {
  return page.getByRole("region", { name: `Réglages du formulaire ${name}`, exact: true });
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
  if (trapFilled) contact.searchParams.set("piege", "rempli");
  await site.goto(contact.href);
  await expect(site.getByRole("heading", { name: "Nous contacter" })).toBeVisible();
}

async function submitContact(site, endpoint, message) {
  await site.getByRole("textbox", { name: "Votre message" }).fill(message);
  const posted = site.waitForResponse(
    (response) => response.url() === endpoint.href && response.request().method() === "POST",
  );
  await site.getByRole("button", { name: "Envoyer le message" }).click();
  return posted;
}

async function addOrigin(region, origin) {
  await region.getByRole("textbox", { name: "Origine", exact: true }).fill(origin);
  await region.getByRole("button", { name: "Ajouter l’origine" }).click();
  await expect(region.getByText(origin, { exact: true })).toBeVisible();
}

async function sendJson(site, endpoint) {
  return site.evaluate(async (url) => {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Demande envoyée en JSON", "fixture-verdict": "accept" }),
      });
      return response.status;
    } catch (error) {
      if (error instanceof TypeError) return "fetch refused";
      throw error;
    }
  }, endpoint.href);
}

/** Open a message from a folder of the sidebar, once the list shows it. */
async function openSubmission(page, folder, message) {
  await page
    .getByRole("navigation", { name: "Messages", exact: true })
    .getByRole("button", { name: new RegExp(`^${folder}`, "u") })
    .click();
  const list = page.getByRole("region", { name: "Liste des messages" });
  const row = list.getByRole("button").filter({ hasText: message });
  await expect(async () => {
    await list.getByRole("button", { name: "Actualiser", exact: true }).click();
    await expect(row).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 10_000 });
  await row.click();
  const reader = page.getByRole("region", { name: "Message ouvert" });
  await expect(reader.getByText(message, { exact: true })).toBeVisible();
  return reader;
}

test("se connecter, créer une organisation et gérer ses formulaires, puis se déconnecter", async ({
  dashboard: page,
  context,
  externalOrigin,
}) => {
  await createOrganization(page);
  await openSection(page, "Formulaires");
  const addedName = "Demandes de devis";
  const renamed = "Devis professionnels";
  await page.getByRole("button", { name: "Nouveau", exact: true }).click();
  await page.getByRole("textbox", { name: "Nom du formulaire" }).fill(addedName);
  await page.getByRole("button", { name: "Ajouter le formulaire" }).click();
  const beforeRename = await publicFormUrl(page, addedName);
  await settingsFor(page, addedName).getByRole("button", { name: "Modifier", exact: true }).click();
  const edit = settingsFor(page, addedName);
  await edit.getByRole("textbox", { name: "Nom du formulaire" }).fill(renamed);
  await edit.getByRole("button", { name: "Enregistrer", exact: true }).click();
  const endpoint = await publicFormUrl(page, renamed);
  expect(endpoint.href).toBe(beforeRename.href);

  const settings = settingsFor(page, renamed);
  await settings.getByRole("button", { name: "Suspendre le formulaire" }).click();
  await settings.getByRole("button", { name: "Confirmer la suspension" }).click();
  await expect(settings.getByRole("button", { name: "Réactiver le formulaire" })).toBeVisible();
  const site = await context.newPage();
  await openContact(site, externalOrigin, endpoint);
  expect((await submitContact(site, endpoint, "Demande pendant la suspension")).status()).toBe(403);
  await settings.getByRole("button", { name: "Réactiver le formulaire" }).click();
  await expect(settings.getByRole("button", { name: "Suspendre le formulaire" })).toBeVisible();
  await openContact(site, externalOrigin, endpoint);
  expect((await submitContact(site, endpoint, "Demande après la réactivation")).status()).toBe(202);

  await page.getByRole("button", { name: /^Compte /u }).click();
  await page.getByRole("menuitem", { name: "Se déconnecter" }).click();
  await expect(page.getByRole("heading", { name: "Connexion" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Connexion" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Messages" })).toHaveCount(0);
});

test("confirmer et rediriger les envois HTML, puis refuser le JSON depuis une origine retirée", async ({
  dashboard: page,
  context,
  dashboardOrigin,
  externalOrigin,
}) => {
  await createOrganization(page);
  await openSection(page, "Formulaires");
  const endpoint = await publicFormUrl(page, formName);
  const site = await context.newPage();
  await openContact(site, externalOrigin, endpoint);
  const confirmation = await submitContact(site, endpoint, "Demande avec confirmation");
  expect(confirmation.status()).toBe(202);
  await expect(site.getByRole("heading", { name: "Message reçu" })).toBeVisible();
  await expect(site).toHaveURL(endpoint.href);

  await openSection(page, "Origines autorisées");
  const origins = page.getByRole("region", {
    name: `Origines autorisées du formulaire ${formName}`,
  });
  await expect(origins.getByText("Aucune origine : tous les sites sont autorisés.")).toBeVisible();
  // An empty allowlist admits all origins, so leave another entry in the list.
  await addOrigin(origins, dashboardOrigin);
  await addOrigin(origins, externalOrigin);

  const successUrl = `${externalOrigin}/merci`;
  const settings = settingsFor(page, formName);
  await openSection(page, "Formulaires");
  await settings.getByRole("textbox", { name: "Adresse de redirection" }).fill(successUrl);
  await settings.getByRole("button", { name: "Enregistrer la redirection" }).click();
  await expect(settings.getByText(successUrl, { exact: true })).toBeVisible();
  await openContact(site, externalOrigin, endpoint);
  const redirect = await submitContact(site, endpoint, "Demande avec redirection");
  expect(redirect.status()).toBe(303);
  await expect(site).toHaveURL(successUrl);
  await expect(site.getByRole("heading", { name: "Merci de votre message" })).toBeVisible();
  expect(await sendJson(site, endpoint)).toBe(202);

  await settings.getByRole("button", { name: "Retirer la redirection" }).click();
  await expect(settings.getByText(successUrl, { exact: true })).toHaveCount(0);
  await openSection(page, "Origines autorisées");
  const externalEntry = origins.getByRole("listitem").filter({ hasText: externalOrigin });
  await externalEntry.getByRole("button", { name: "Retirer", exact: true }).click();
  await expect(externalEntry).toHaveCount(0);
  await expect(origins.getByText(dashboardOrigin, { exact: true })).toBeVisible();
  // Use a new URL so Chromium sends a fresh CORS preflight after removal.
  const afterRemoval = new URL("?origine=retiree", endpoint);
  expect(await sendJson(site, afterRemoval)).toBe("fetch refused");
});

test("mettre en quarantaine un message au champ piège rempli et le revoir", async ({
  dashboard: page,
  context,
  externalOrigin,
}) => {
  await createOrganization(page);
  await openSection(page, "Formulaires");
  const endpoint = await publicFormUrl(page, formName);
  const settings = settingsFor(page, formName);
  await settings.getByRole("textbox", { name: "Nom du champ piège" }).fill("societe");
  await settings.getByRole("button", { name: "Enregistrer le champ piège" }).click();
  await expect(settings.getByRole("button", { name: "Retirer le champ piège" })).toBeVisible();

  const site = await context.newPage();
  await openContact(site, externalOrigin, endpoint, true);
  const message = "Demande saisie avec un champ caché rempli";
  expect((await submitContact(site, endpoint, message)).status()).toBe(202);
  await expect(site.getByRole("heading", { name: "Message reçu" })).toBeVisible();
  const reader = await openSubmission(page, "À vérifier", message);
  await expect(reader.getByText("Champ piège rempli", { exact: true })).toBeVisible();
  await reader.getByRole("button", { name: "Accepter et envoyer" }).click();
  // An accepted message leaves the folder of the messages to review.
  await expect(reader.getByText(message, { exact: true })).toHaveCount(0);
  const accepted = await openSubmission(page, "Acceptés", message);
  await expect(accepted.getByText("Accepté", { exact: true })).toBeVisible();
  await expect(accepted.getByRole("button", { name: "Accepter et envoyer" })).toHaveCount(0);
});

test("ajouter des destinations, envoyer un essai et relancer un webhook en échec", async ({
  dashboard: page,
  context,
  externalOrigin,
}) => {
  await createOrganization(page);
  await openSection(page, "Formulaires");
  const endpoint = await publicFormUrl(page, formName);
  const receiver = "https://webhooks.example.test/bad-request-once";
  const email = "equipe@example.test";
  await openSection(page, "Destinations");
  const webhooks = page.getByRole("region", { name: `Webhooks du formulaire ${formName}` });
  await expect(webhooks.getByText("Aucun webhook pour ce formulaire.")).toBeVisible();
  await webhooks.getByRole("textbox", { name: "URL du webhook" }).fill(receiver);
  await webhooks.getByRole("button", { name: "Ajouter le webhook" }).click();
  const secret = webhooks.getByText(/^whsec_[\w-]{43}$/u);
  await expect(secret).toBeVisible();
  await webhooks.getByRole("button", { name: "Masquer", exact: true }).click();
  await expect(secret).toHaveCount(0);
  // Leaving the page and coming back lists the webhook without its secret.
  await openSection(page, "Formulaires");
  await openSection(page, "Destinations");
  const webhook = webhooks.getByRole("listitem").filter({ hasText: receiver });
  await expect(webhook).toBeVisible();
  await expect(secret).toHaveCount(0);

  const emails = page.getByRole("region", {
    name: `Destinations e-mail du formulaire ${formName}`,
  });
  await expect(emails.getByText("Aucune destination e-mail pour ce formulaire.")).toBeVisible();
  await emails.getByRole("textbox", { name: "Destinataires, un par ligne" }).fill(email);
  await emails.getByRole("button", { name: "Ajouter la destination" }).click();
  const destination = emails.getByRole("listitem").filter({ hasText: email });
  await expect(destination).toBeVisible();
  await destination.getByRole("button", { name: "Envoyer un essai" }).click();
  await expect(destination.getByRole("status")).toHaveText(/Message d’essai livré/u);

  const site = await context.newPage();
  await openContact(site, externalOrigin, endpoint);
  const message = "Demande avec historique de livraison";
  expect((await submitContact(site, endpoint, message)).status()).toBe(202);
  const reader = await openSubmission(page, "Acceptés", message);
  const history = reader.getByRole("region", { name: "Livraisons du message" });
  // Only a delivery names its destination. The attempts listed inside it do not.
  const webhookDelivery = history.getByRole("listitem").filter({ hasText: receiver });
  const refresh = history.getByRole("button", { name: "Actualiser les livraisons" });
  const retry = webhookDelivery.getByRole("button", { name: "Relancer la livraison" });
  await expect(async () => {
    await refresh.click();
    await expect(retry).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 10_000 });
  await expect(webhookDelivery.getByText("Échec", { exact: true })).toBeVisible();
  await expect(webhookDelivery).toContainText("400");
  await webhookDelivery.getByText("1 tentative", { exact: true }).click();
  await expect(webhookDelivery.getByRole("listitem")).toContainText("échec définitif");
  await retry.click();
  await expect(async () => {
    await refresh.click();
    await expect(webhookDelivery.getByText("Livrée", { exact: true })).toBeVisible({
      timeout: 500,
    });
  }).toPass({ timeout: 10_000 });
  // The list of attempts is still open from the first look.
  await expect(webhookDelivery.getByText("2 tentatives", { exact: true })).toBeVisible();
  await expect(webhookDelivery.getByRole("listitem")).toHaveCount(2);
  await expect(
    webhookDelivery.getByRole("listitem").filter({ hasText: "Tentative 2" }),
  ).toContainText("livrée");
  await expect(retry).toHaveCount(0);
  const emailDelivery = history.getByRole("listitem").filter({ hasText: `E-mail à ${email}` });
  await expect(emailDelivery.getByText("Livrée", { exact: true })).toBeVisible();
  await expect(emailDelivery.getByText("1 tentative", { exact: true })).toBeVisible();

  await openSection(page, "Destinations");
  await webhook.getByRole("button", { name: "Envoyer un essai" }).click();
  await expect(webhook.getByRole("status")).toHaveText(/Message d’essai livré/u);
});

test("voir un nouveau message dans l’état du traitement après l’avoir actualisé", async ({
  dashboard: page,
  context,
  externalOrigin,
}) => {
  await createOrganization(page);
  await openSection(page, "Formulaires");
  const endpoint = await publicFormUrl(page, formName);
  await openSection(page, "État", "Exploitation");
  const status = page.getByRole("region", { name: "État de Atelier Rondyr" });
  await expect(status).toContainText(/Messages reçus\s*0/u);

  const site = await context.newPage();
  await openContact(site, externalOrigin, endpoint);
  expect((await submitContact(site, endpoint, "Demande comptée dans l’état")).status()).toBe(202);
  await page.getByRole("button", { name: "Actualiser", exact: true }).click();

  await expect(status).toContainText(/Messages reçus\s*1/u);
});
