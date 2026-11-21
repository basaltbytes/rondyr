import {
  createPlugin as createFormsPlugin,
  type FormsPluginOptions,
} from "@emdash-cms/plugin-forms";
import type { ResolvedPlugin } from "emdash";

/**
 * The forms plugin as `formsWithoutSubmissions()` loads it. EmDash builds the
 * admin menu and the dashboard of a native plugin from `createPlugin()`, not
 * from its descriptor, so the Submissions page and the Recent Submissions
 * widget are removed here. Every route, hook and storage collection stays.
 */
export function createPlugin(options: FormsPluginOptions = {}): ResolvedPlugin {
  const plugin = createFormsPlugin(options);
  return {
    ...plugin,
    admin: {
      ...plugin.admin,
      pages: (plugin.admin.pages ?? []).filter(({ path }) => path !== "/submissions"),
      widgets: [],
    },
  };
}
