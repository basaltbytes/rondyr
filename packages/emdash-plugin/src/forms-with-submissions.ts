import {
  createPlugin as createFormsPlugin,
  type FormsPluginOptions,
} from "@emdash-cms/plugin-forms";
import type { ResolvedPlugin } from "emdash";

import { withRondyrHandoff } from "./forms-handoff.ts";

/**
 * The forms plugin as `formsWithRondyr()` loads it: its Submissions page and
 * its Recent Submissions widget stay, and `submit` and the digest hold the
 * emails of a form linked to Rondyr (see `forms-handoff.ts`).
 */
export function createPlugin(options: FormsPluginOptions = {}): ResolvedPlugin {
  return withRondyrHandoff(createFormsPlugin(options));
}
