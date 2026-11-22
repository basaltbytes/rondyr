import { z } from "astro/zod";

import { DeclaredForms } from "./core/declared-forms.ts";

/**
 * The options of `rondyr({ url })` in astro.config.mjs: the HTTPS origin of the
 * Rondyr Worker. EmDash lets a plugin call public hosts only, so a local
 * address can't work.
 */
export const RondyrOptions = z.object({
  url: z.url({ protocol: /^https$/u }).transform((url) => new URL(url).origin),
  forms: DeclaredForms.optional(),
});
export type RondyrOptions = z.input<typeof RondyrOptions>;
export type ResolvedOptions = z.output<typeof RondyrOptions>;

/** The host the plugin may call, as EmDash compares it: the hostname, without a port. */
export function rondyrHost(options: ResolvedOptions): string {
  return new URL(options.url).hostname;
}
