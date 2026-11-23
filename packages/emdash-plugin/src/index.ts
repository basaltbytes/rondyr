import type { FormsPluginOptions } from "@emdash-cms/plugin-forms";
import type { PluginDescriptor } from "emdash";

import { pluginId, pluginVersion } from "./constants.ts";
import { RondyrOptions, rondyrHost } from "./options.ts";
import { descriptorStorage } from "./store.ts";

export type { RondyrOptions } from "./options.ts";

// Astro loads this module for its configuration. The forms plugin is optional.
const formsPlugin = await import("@emdash-cms/plugin-forms").then(
  (module) => module.formsPlugin,
  (error) => {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ERR_MODULE_NOT_FOUND" || error.code === "MODULE_NOT_FOUND") &&
      error.message.includes("@emdash-cms/plugin-forms")
    )
      return undefined;
    throw error;
  },
);

function formsDescriptor(options: FormsPluginOptions): PluginDescriptor<FormsPluginOptions> {
  if (formsPlugin === undefined)
    throw new Error("Install @emdash-cms/plugin-forms to use the forms plugin mode");
  return formsPlugin(options);
}

/**
 * The Rondyr plugin, for `plugins` in astro.config.mjs:
 * `rondyr({ url: "https://rondyr.example.com" })`. The URL is the origin of
 * the Rondyr Worker; the plugin may call that host only.
 */
export function rondyr(options: RondyrOptions): PluginDescriptor<RondyrOptions> {
  const resolved = RondyrOptions.parse(options);
  return {
    id: pluginId,
    version: pluginVersion,
    entrypoint: "@basaltbytes/emdash-plugin-rondyr/plugin",
    adminEntry: "@basaltbytes/emdash-plugin-rondyr/admin",
    options: resolved,
    capabilities: ["email:send", "network:request"],
    allowedHosts: [rondyrHost(resolved)],
    adminPages: [
      { path: "/", label: "Messages", icon: "inbox" },
      { path: "/settings", label: "Rondyr settings", icon: "gear" },
    ],
    adminWidgets: [{ id: "to-review", title: "Messages to review", size: "third" }],
    storage: descriptorStorage,
  };
}

/**
 * The forms plugin for a site whose messages are read in Rondyr, without its
 * Submissions page and its Recent Submissions widget. It still validates,
 * stores and answers each submission, and its copy becomes a backup. For a
 * form linked to a Rondyr form, its notification, its daily digest and its
 * auto-reply wait for Rondyr: the notification and the digest are replaced by
 * the Rondyr plugin's emails, and the auto-reply goes out once Rondyr accepts
 * the message. Use it in place of `formsPlugin()` from `@emdash-cms/plugin-forms`.
 */
export function formsWithoutSubmissions(
  options: FormsPluginOptions = {},
): PluginDescriptor<FormsPluginOptions> {
  const descriptor = formsDescriptor(options);
  return {
    ...descriptor,
    entrypoint: "@basaltbytes/emdash-plugin-rondyr/forms",
    adminPages: (descriptor.adminPages ?? []).filter(({ path }) => path !== "/submissions"),
    adminWidgets: [],
  };
}

/**
 * `formsWithoutSubmissions()` with the forms plugin's Submissions page and
 * Recent Submissions widget, for a site whose editors still read the forms
 * plugin's copy. Use it in place of `formsPlugin()` from `@emdash-cms/plugin-forms`.
 */
export function formsWithRondyr(
  options: FormsPluginOptions = {},
): PluginDescriptor<FormsPluginOptions> {
  return {
    ...formsDescriptor(options),
    entrypoint: "@basaltbytes/emdash-plugin-rondyr/forms-with-submissions",
  };
}
