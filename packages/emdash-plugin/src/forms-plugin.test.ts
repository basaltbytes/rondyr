import { createPlugin as createFormsPlugin, formsPlugin } from "@emdash-cms/plugin-forms";
import { describe, expect, it } from "vitest";

import { createPlugin } from "./forms-plugin.ts";
import { formsWithoutSubmissions } from "./index.ts";

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
    expect(Object.keys(trimmed.routes)).toEqual(Object.keys(original.routes));
    expect(routeAccess(trimmed)).toEqual(routeAccess(original));
    expect(trimmed.routes["submit"]?.handler).toBe(original.routes["submit"]?.handler);
    expect(Object.keys(trimmed.hooks)).toEqual(Object.keys(original.hooks));
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
