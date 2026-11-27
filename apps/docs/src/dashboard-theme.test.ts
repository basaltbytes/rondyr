import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { dashboardThemeCss, dashboardTokens } from "./dashboard-theme.ts";

const stylesheet = readFileSync(
  new URL("../../rondyr/src/dashboard/dashboard.css", import.meta.url),
  "utf8",
);

test("reads every token of the excerpts from the dashboard stylesheet, for both themes", () => {
  const [light, dark] = dashboardThemeCss(stylesheet).split("\n");
  assert.ok(light?.startsWith(".rondyr-ui{"));
  assert.ok(dark?.startsWith(':root[data-theme="dark"] .rondyr-ui{'));
  for (const token of dashboardTokens) {
    assert.match(light ?? "", new RegExp(`--ui-${token}:oklch\\(`, "u"), token);
    assert.match(dark ?? "", new RegExp(`--ui-${token}:oklch\\(`, "u"), token);
  }
  assert.notEqual(light?.slice(light.indexOf("{")), dark?.slice(dark.indexOf("{")));
});

test("takes the light palette from :root and the dark one from .dark", () => {
  const css = dashboardThemeCss(
    [":root {", ...dashboardTokens.map((token) => `  --${token}: light;`), "}", ""]
      .concat([".dark {", ...dashboardTokens.map((token) => `  --${token}: dark;`), "}"])
      .join("\n"),
  );
  assert.match(css, /^\.rondyr-ui\{--ui-background:light;/u);
  assert.match(css, /\n:root\[data-theme="dark"\] \.rondyr-ui\{--ui-background:dark;/u);
});

test("names the token that the dashboard stylesheet no longer has", () => {
  assert.throws(
    () => dashboardThemeCss(":root {\n  --background: white;\n}\n.dark {\n}"),
    /":root" block of the dashboard stylesheet has no --foreground/u,
  );
  assert.throws(() => dashboardThemeCss("body {\n}"), /no ":root" block/u);
});
