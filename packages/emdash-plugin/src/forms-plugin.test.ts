import { createPlugin as createFormsPlugin, formsPlugin } from "@emdash-cms/plugin-forms";
import { describe, expect, it } from "vitest";

import { createPlugin } from "./forms-plugin.ts";
import { formsWithoutSubmissions, formsWithRondyr } from "./index.ts";

/** Who may call each route of a plugin, and whether it validates its input. */
function routeAccess(plugin: ReturnType<typeof createPlugin>) {
  return Object.entries(plugin.routes).map(([name, route]) => ({
    name,
    public: route.public,
    permission: route.permission,
    validated: route.input !== undefined,
  }));
}

describe("formsWithoutSubmissions", () => {
  it("keeps the forms plugin's routes, hooks and storage, without the Submissions page and widget", () => {
    const original = createFormsPlugin({ defaultSpamProtection: "honeypot" });
    const trimmed = createPlugin({ defaultSpamProtection: "honeypot" });
    // Every route of the forms plugin, with the same access, then the two admin
    // routes that list and clear the submissions posted straight to it.
    const added = ["rondyr/bypassed", "rondyr/bypassed/clear"];
    expect(Object.keys(trimmed.routes)).toEqual([...Object.keys(original.routes), ...added]);
    expect(routeAccess(trimmed)).toEqual([
      ...routeAccess(original),
      { name: "rondyr/bypassed", public: undefined, permission: undefined, validated: false },
      { name: "rondyr/bypassed/clear", public: undefined, permission: undefined, validated: true },
    ]);
    // `submit` validates the same input; its handler runs the forms plugin's own
    // handler around the Rondyr handoff, which forms-handoff.test.ts exercises.
    expect(trimmed.routes["submit"]?.input).toBe(original.routes["submit"]?.input);
    expect(trimmed.routes["submit"]?.handler).not.toBe(original.routes["submit"]?.handler);
    for (const name of ["definition", "forms/create", "submissions/export"]) {
      expect(trimmed.routes[name]?.handler).toBe(original.routes[name]?.handler);
    }
    expect(Object.keys(trimmed.hooks)).toEqual(Object.keys(original.hooks));
    const { handler: _cron, ...cron } = trimmed.hooks.cron ?? {};
    const { handler: _originalCron, ...originalCron } = original.hooks.cron ?? {};
    expect(cron).toEqual(originalCron);
    expect(trimmed.storage).toEqual(original.storage);
    expect(trimmed.id).toBe(original.id);
    expect(trimmed.admin.pages).toEqual([{ path: "/", label: "Forms", icon: "list" }]);
    expect(trimmed.admin.widgets).toEqual([]);
    expect(trimmed.admin.portableTextBlocks).toEqual(original.admin.portableTextBlocks);
    expect(trimmed.admin.settingsSchema).toEqual(original.admin.settingsSchema);
  });

  it("points EmDash at that plugin, with the forms plugin's descriptor otherwise", () => {
    const { entrypoint, adminPages, adminWidgets, ...rest } = formsWithoutSubmissions();
    const {
      entrypoint: _entrypoint,
      adminPages: _pages,
      adminWidgets: _widgets,
      ...original
    } = formsPlugin();
    expect(entrypoint).toBe("@basaltbytes/emdash-plugin-rondyr/forms");
    expect(adminPages).toEqual([{ path: "/", label: "Forms", icon: "list" }]);
    expect(adminWidgets).toEqual([]);
    expect(rest).toEqual(original);
  });
});

describe("formsWithRondyr", () => {
  it("points EmDash at the forms plugin that holds its emails and keeps its Submissions page", () => {
    const { entrypoint, ...rest } = formsWithRondyr({ defaultSpamProtection: "honeypot" });
    const { entrypoint: _entrypoint, ...original } = formsPlugin({
      defaultSpamProtection: "honeypot",
    });
    expect(entrypoint).toBe("@basaltbytes/emdash-plugin-rondyr/forms-with-submissions");
    expect(rest).toEqual(original);
  });
});
