import { expect } from "@playwright/test";

import { testSetupToken } from "../integration/auth-fixture.ts";
import { owner, t, test } from "./fixtures.mjs";

// A fresh deployment has no account. Its address can be found by anyone, so the page
// creates the owner account only with the setup token chosen at deployment.
test.use({ claimed: false });

async function fillOwnerForm(page, token) {
  // Password inputs have no implicit ARIA role.
  await page.getByLabel(t("setup.token")).fill(token);
  await page.getByRole("textbox", { name: t("setup.name") }).fill(owner.name);
  await page.getByRole("textbox", { name: t("setup.email") }).fill(owner.email);
  await page.getByLabel(t("setup.password"), { exact: true }).fill(owner.password);
  await page.getByRole("button", { name: t("setup.submit") }).click();
}

test("a new instance creates its owner account with the setup token only", async ({
  page,
  dashboardOrigin,
}) => {
  await page.goto(dashboardOrigin);
  await expect(page.getByRole("heading", { name: t("setup.title") })).toBeVisible();
  await expect(page.getByRole("button", { name: t("authentication.signIn.submit") })).toHaveCount(
    0,
  );

  await fillOwnerForm(page, "a guess at the setup token that is long enough");
  await expect(page.getByText(t("setup.problems.refused"))).toBeVisible();

  await fillOwnerForm(page, testSetupToken);
  // The owner is signed in, and the dashboard opens on its first run.
  await expect(page.getByRole("heading", { name: t("inbox.sections.organization") })).toBeVisible();

  // The instance is claimed: a visitor sees the sign-in form.
  await page.context().clearCookies();
  await page.reload();
  await expect(
    page.getByRole("button", { name: t("authentication.signIn.submit"), exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: t("setup.title") })).toHaveCount(0);
});
