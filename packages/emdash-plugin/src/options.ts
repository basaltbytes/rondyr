import { z } from "astro/zod";

/**
 * The options of `rondyr({ url })` in astro.config.mjs: the origin of the
 * Rondyr Worker, HTTPS except on localhost.
 */
export const RondyrOptions = z.object({
  url: z
    .url()
    .transform((url) => new URL(url))
    .refine(
      (url) =>
        url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)),
      "The Rondyr URL must use HTTPS",
    )
    .transform((url) => url.origin),
});
export type RondyrOptions = z.input<typeof RondyrOptions>;
export type ResolvedOptions = z.output<typeof RondyrOptions>;
