import { formsPlugin, type FormsPluginOptions } from "@emdash-cms/plugin-forms";
import type { PluginDescriptor } from "emdash";

import { pluginId, pluginVersion } from "./constants.ts";
import { RondyrOptions } from "./options.ts";
import { descriptorStorage } from "./store.ts";

export type { RondyrOptions } from "./options.ts";

/**
 * The Rondyr plugin, for `plugins` in astro.config.mjs:
 * `rondyr({ url: "https://rondyr.example.com" })`. The URL is the origin of
 * the Rondyr Worker; the plugin may call that host only.
 */
export function rondyr(options: RondyrOptions): PluginDescriptor<RondyrOptions> {
  const { url } = RondyrOptions.parse(options);
  return {
    id: pluginId,
    version: pluginVersion,
    entrypoint: "@basaltbytes/emdash-plugin-rondyr/plugin",
    adminEntry: "@basaltbytes/emdash-plugin-rondyr/admin",
    options: { url },
    capabilities: ["email:send", "network:request"],
    allowedHosts: [new URL(url).host],
    adminPages: [
      { path: "/", label: "Messages", icon: "inbox" },
      { path: "/settings", label: "Rondyr settings", icon: "gear" },
    ],
    adminWidgets: [{ id: "to-review", title: "Messages to review", size: "third" }],
    storage: descriptorStorage,
  };
}

/**
 * The forms plugin without its Submissions page and its Recent Submissions
 * widget, for a site whose messages are read in Rondyr. Its routes, storage and
 * cron tasks do not change: it still validates, stores and answers each
 * submission, and its copy becomes a backup. Use it in place of
 * `formsPlugin()` from `@emdash-cms/plugin-forms`.
 */
export function formsWithoutSubmissions(
  options: FormsPluginOptions = {},
): PluginDescriptor<FormsPluginOptions> {
  const descriptor = formsPlugin(options);
  return {
    ...descriptor,
    entrypoint: "@basaltbytes/emdash-plugin-rondyr/forms",
    adminPages: (descriptor.adminPages ?? []).filter(({ path }) => path !== "/submissions"),
    adminWidgets: [],
  };
}
